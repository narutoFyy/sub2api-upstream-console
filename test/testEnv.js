const os = require('node:os');
const path = require('node:path');

process.env.DATABASE_PATH ||= path.join(os.tmpdir(), `sub2api-console-test-${process.pid}.sqlite`);
process.env.APP_SECRET ||= 'test-only-secret';
process.env.SYNC_SCHEDULER_ENABLED = 'false';
process.env.KEY_CHECK_SCHEDULER_ENABLED = 'false';
