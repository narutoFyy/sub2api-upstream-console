const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const config = require('./config');
const db = require('./db');

const execFileAsync = promisify(execFile);
const UPDATE_STATUS_FILE = 'update-status.json';
const safeRefPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function assertSafeRef(value, label) {
  if (!safeRefPattern.test(value) || value.includes('..')) {
    throw new Error(`${label} 配置不合法`);
  }
  return value;
}

function commandError(error) {
  const output = String(error.stderr || error.stdout || error.message || '命令执行失败').trim();
  return output.slice(-2000);
}

function createCommandRunner(rootDir = config.rootDir) {
  return async (command, args, options = {}) => {
    try {
      const result = await execFileAsync(command, args, {
        cwd: rootDir,
        timeout: options.timeout || 120000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' }
      });
      return String(result.stdout || '').trim();
    } catch (error) {
      error.safeMessage = commandError(error);
      throw error;
    }
  };
}

function createUpdateService(options = {}) {
  const serviceStartedAt = Date.now();
  const environment = options.environment || config;
  const database = options.database || db;
  const run = options.run || createCommandRunner(environment.rootDir);
  const restart = options.restart || (() => {});
  const statusPath = path.join(environment.updateBackupDir, UPDATE_STATUS_FILE);
  let running = false;
  let currentStatus = readPersistedStatus();
  if (currentStatus.phase === 'restarting' && Date.parse(currentStatus.completed_at || 0) < serviceStartedAt) {
    currentStatus = { ...currentStatus, phase: 'completed', message: '更新已完成' };
  }

  function readPersistedStatus() {
    try {
      return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    } catch {
      return { phase: 'idle', message: '' };
    }
  }

  function saveStatus(patch) {
    currentStatus = { ...currentStatus, ...patch, updated_at: new Date().toISOString() };
    fs.mkdirSync(environment.updateBackupDir, { recursive: true });
    const temporaryPath = `${statusPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(currentStatus, null, 2));
    fs.renameSync(temporaryPath, statusPath);
    return currentStatus;
  }

  async function git(args, options) {
    return run('git', args, options);
  }

  async function inspect({ refresh = false } = {}) {
    const packagePath = path.join(environment.rootDir, 'package.json');
    const localPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const base = {
      enabled: Boolean(environment.selfUpdateEnabled),
      current_version: localPackage.version || '0.0.0',
      remote: environment.selfUpdateRemote,
      branch: environment.selfUpdateBranch,
      running,
      operation: currentStatus
    };
    if (!environment.selfUpdateEnabled) {
      return { ...base, available: false, message: '服务器未启用在线更新' };
    }

    const remote = assertSafeRef(environment.selfUpdateRemote, '更新远端');
    const branch = assertSafeRef(environment.selfUpdateBranch, '更新分支');
    const remoteRef = `${remote}/${branch}`;
    await git(['rev-parse', '--is-inside-work-tree']);
    if (refresh) await git(['fetch', '--quiet', remote, branch], { timeout: 120000 });

    const [currentCommit, remoteCommit, dirty, counts, remotePackageText, logText] = await Promise.all([
      git(['rev-parse', 'HEAD']),
      git(['rev-parse', remoteRef]),
      git(['status', '--porcelain']),
      git(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]),
      git(['show', `${remoteRef}:package.json`]),
      git(['log', '--format=%h%x09%s', '-10', `HEAD..${remoteRef}`])
    ]);
    const [ahead = 0, behind = 0] = counts.split(/\s+/).map(Number);
    const remotePackage = JSON.parse(remotePackageText);
    return {
      ...base,
      current_commit: currentCommit.slice(0, 8),
      remote_commit: remoteCommit.slice(0, 8),
      latest_version: remotePackage.version || localPackage.version || '0.0.0',
      ahead,
      behind,
      dirty: Boolean(dirty),
      divergent: ahead > 0 && behind > 0,
      available: behind > 0 && ahead === 0 && !dirty,
      commits: logText ? logText.split('\n').map((line) => {
        const [commit, ...subject] = line.split('\t');
        return { commit, subject: subject.join('\t') };
      }) : [],
      message: dirty
        ? '服务器源码有未提交修改，不能在线更新'
        : ahead > 0 && behind > 0
          ? '服务器分支与远端已经分叉，需要人工处理'
          : behind > 0
            ? `发现 ${behind} 个新提交`
            : ahead > 0
              ? '服务器版本领先于远端'
              : '当前已是最新版本'
    };
  }

  async function rollback(commit) {
    await git(['reset', '--hard', commit]);
    await run('npm', ['ci', '--omit=dev'], { timeout: 300000 });
  }

  async function performUpdate() {
    let previousCommit = '';
    let codeChanged = false;
    try {
      saveStatus({ phase: 'checking', message: '正在检查远端版本', error: '' });
      const before = await inspect({ refresh: true });
      if (!before.available) throw new Error(before.message || '当前没有可安装的更新');
      previousCommit = await git(['rev-parse', 'HEAD']);

      saveStatus({ phase: 'backup', message: '正在备份数据库', from_commit: previousCommit.slice(0, 8) });
      fs.mkdirSync(environment.updateBackupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(environment.updateBackupDir, `upstream-console-before-update-${stamp}.sqlite`);
      await database.backup(backupPath);

      saveStatus({ phase: 'code', message: '正在安装新版本', backup_path: backupPath });
      await git(['merge', '--ff-only', `${environment.selfUpdateRemote}/${environment.selfUpdateBranch}`]);
      codeChanged = true;
      await run('npm', ['ci', '--omit=dev'], { timeout: 300000 });

      saveStatus({ phase: 'testing', message: '正在运行上线测试' });
      await run('npm', ['test'], { timeout: 300000 });
      const newCommit = await git(['rev-parse', 'HEAD']);
      const newPackage = JSON.parse(fs.readFileSync(path.join(environment.rootDir, 'package.json'), 'utf8'));
      saveStatus({
        phase: 'restarting',
        message: '更新成功，服务正在重启',
        version: newPackage.version,
        to_commit: newCommit.slice(0, 8),
        completed_at: new Date().toISOString(),
        error: ''
      });
      running = false;
      restart();
    } catch (error) {
      let rollbackMessage = '';
      if (codeChanged && previousCommit) {
        try {
          saveStatus({ phase: 'rollback', message: '更新失败，正在恢复原版本' });
          await rollback(previousCommit);
          rollbackMessage = '，已恢复原版本';
        } catch (rollbackError) {
          rollbackMessage = `；自动回退也失败：${rollbackError.safeMessage || rollbackError.message}`;
        }
      }
      running = false;
      saveStatus({
        phase: 'failed',
        message: `更新失败${rollbackMessage}`,
        error: error.safeMessage || error.message || '未知错误',
        failed_at: new Date().toISOString()
      });
    }
  }

  async function check() {
    if (running) return inspect();
    return inspect({ refresh: true });
  }

  async function start() {
    if (!environment.selfUpdateEnabled) throw new Error('服务器未启用在线更新');
    if (running) throw new Error('更新任务正在执行');
    const status = await inspect({ refresh: true });
    if (!status.available) throw new Error(status.message || '当前没有可安装的更新');
    running = true;
    saveStatus({ phase: 'queued', message: '更新任务已开始', error: '' });
    setImmediate(performUpdate);
    return { accepted: true, operation: currentStatus };
  }

  return { inspect, check, start };
}

module.exports = { createCommandRunner, createUpdateService };
