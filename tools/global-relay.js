const { createGlobalRelay, DEFAULT_RELAY_PORT } = require('../src/global-relay');

const port = Number(process.env.LABSHOW_RELAY_PORT || DEFAULT_RELAY_PORT);
const relay = createGlobalRelay({ port });

relay.start().then(({ port: listeningPort }) => {
    console.log(`خادم مطابقة Lab show يعمل على المنفذ ${listeningPort}`);
    console.log('هذا الخادم ينقل رسائل المطابقة فقط ولا يستقبل بثاً.');
}).catch((error) => {
    console.error('تعذر تشغيل خادم المطابقة:', error);
    process.exit(1);
});

const shutdown = async () => {
    await relay.stop();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
