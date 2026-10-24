const repo = require('./repository');
const { pushPlusStatus, sendPushPlus } = require('./pushPlusClient');
const { emailStatus, sendEmail } = require('./emailClient');

function notificationCycle(item) {
  return item.kind === 'recovery' ? 'recovery' : (item.alert?.last_notified_at || item.alert?.notified_at || 'initial');
}

async function deliverNotificationGroup(group, payload, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const channels = dependencies.channels || [
    ...(pushPlusStatus(dependencies).configured ? [{ id: 'pushplus', send: sendPushPlus }] : []),
    ...(emailStatus(dependencies).enabled ? [{ id: 'email', send: sendEmail }] : [])
  ];
  if (!channels.length) throw new Error('未配置启用的通知渠道');
  const results = await Promise.allSettled(channels.map(async (channel) => {
    const pending = group.filter((item) => item.alert?.id == null || !repository.hasNotificationDelivery?.(
      item.alert.id, item.kind, channel.id, notificationCycle(item)
    ));
    if (!pending.length) return;
    await channel.send(payload, dependencies);
    for (const item of pending) {
      if (item.alert?.id == null) continue;
      repository.recordNotificationDelivery?.(item.alert.id, item.kind, channel.id, notificationCycle(item));
    }
  }));
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [`${channels[index].id}: ${result.reason.message}`] : []);
  if (failures.length) throw new Error(failures.join('；'));
}

module.exports = { deliverNotificationGroup };
