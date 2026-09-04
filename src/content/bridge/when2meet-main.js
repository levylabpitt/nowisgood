/*  nowisgood - when2meet MAIN-world bridge
 *
 *  Content scripts run in an isolated world and can't see the page's own
 *  globals. when2meet sets window.UserID once you've signed in to the event,
 *  and that id is the difference between a fill that saves and one that only
 *  looks filled. This tiny shim runs in the page world and answers the content
 *  script's request for it.
 */
(function () {
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.__nigReq !== "when2meetUserId") return;
    var uid = 0;
    try {
      uid = typeof window.UserID !== "undefined" && window.UserID ? window.UserID : 0;
    } catch (_) {}
    window.postMessage({ __nigRes: "when2meetUserId", userId: uid }, "*");
  });
})();
