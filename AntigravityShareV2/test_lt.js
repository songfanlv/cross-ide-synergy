const localtunnel = require('localtunnel');

(async () => {
    try {
        const tunnel = await localtunnel({ port: 8123, subdomain: 'ag-share-test1234' });
        console.log('Tunnel URL:', tunnel.url);
        tunnel.close();
    } catch (err) {
        console.error('Error:', err);
    }
})();
