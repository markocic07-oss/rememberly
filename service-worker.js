self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === "string" ? payload.title : "Rememberly";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "You have an important update.",
    tag: typeof payload.tag === "string" ? payload.tag : "rememberly-update",
    data: { url: typeof payload.url === "string" ? payload.url : "/?briefing=1" },
    renotify: false
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const path = event.notification.data?.url || "/?briefing=1";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const requestedTarget = new URL(path, self.location.origin);
    const target = requestedTarget.origin === self.location.origin ? requestedTarget : new URL("/?briefing=1", self.location.origin);
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && "navigate" in client) {
        await client.navigate(target.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  })());
});
