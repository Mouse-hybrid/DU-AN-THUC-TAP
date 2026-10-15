import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      on('task', {
        des05Note(message) {
          console.log(`[DES-QA-05] ${message}`);
          return null;
        },
        des06Note(message) {
          console.log(`[DES-QA-06] ${message}`);
          return null;
        },
        async des05ParallelSend({ url, token, keys }) {
          const target = new URL(url);
          if (!/^\/api\/v1\/orders\/[0-9a-f-]{36}\/send-to-kitchen$/i.test(target.pathname) ||
              target.protocol !== 'http:' || !token || !Array.isArray(keys) ||
              keys.length !== 2 || keys.some((key) => typeof key !== 'string' || !key)) {
            throw new Error('DES05 concurrent Send inputs invalid');
          }
          // Launch both requests before awaiting either response. Never return credentials.
          return Promise.all(keys.map(async (key) => {
            const response = await fetch(url, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
              signal: AbortSignal.timeout(20000),
            });
            const responseText = await response.text();
            let body = null;
            try { body = JSON.parse(responseText); } catch { /* Preserve HTTP status for non-JSON failures. */ }
            return {
              status: response.status,
              body,
              server: response.headers.get('server'),
              via: response.headers.get('via'),
              requestId: response.headers.get('x-request-id'),
            };
          }));
        },
      });
    },
    // Bật ghi video và chụp màn hình
    video: true,
    videosFolder: "cypress/videos",
    screenshotsFolder: "cypress/screenshots",
    screenshotOnRunFailure: true, // Tự động chụp ảnh khi test case thất bại
    trashAssetsBeforeRuns: true,   // Tự dọn sạch video/ảnh cũ trước mỗi lượt chạy
  },
});
