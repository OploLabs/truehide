/* Homepage behavior: PWA install button.
   (Footer year is updated by shared/base.js on every page.) */

(function () {
  const installButton = document.querySelector(".install-button");
  const installHint = document.querySelector(".install-hint");
  let deferredPrompt = null;

  /* Chromium-based browsers expose the install prompt. Show the button;
     in other browsers the hint line is shown instead. */
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;

    if (installButton) {
      installButton.hidden = false;
      installButton.addEventListener("click", async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        installButton.hidden = true;
        if (installHint) installHint.hidden = true;
      });
    }

    if (installHint) installHint.hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    if (installButton) installButton.hidden = true;
    if (installHint) installHint.hidden = true;
  });
})();
