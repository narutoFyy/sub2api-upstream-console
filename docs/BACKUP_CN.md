# 备份说明

## 需要备份什么

核心数据在 SQLite 数据库中：

```text
data/upstream-console.sqlite
```

其中包含上游配置、加密后的凭证、余额快照、倍率快照和同步日志。

## 页面备份

控制台右上角的“备份数据库”按钮会下载当前 SQLite 数据库文件。

## 手动备份

停止服务后复制：

```powershell
copy data\upstream-console.sqlite backups\upstream-console.sqlite
```

如果服务正在运行，建议使用页面按钮下载，或者先停止服务再复制，避免复制到未完成写入的文件。

## 恢复

1. 停止服务。
2. 用备份文件覆盖 `data/upstream-console.sqlite`。
3. 确认 `.env` 中的 `APP_SECRET` 和备份时一致。
4. 重启服务。

如果 `APP_SECRET` 不一致，旧凭证无法解密，需要重新填写上游账号密码或 Token。
