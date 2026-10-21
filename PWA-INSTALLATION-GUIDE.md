# Installing the S.L.I.D.E. App

S.L.I.D.E. is a Progressive Web App (PWA). It can be installed from a web browser and opened from the Home Screen, Start menu, desktop, Dock, or application launcher without downloading it from an app store.

Production address: **https://slide.joalvergs.tech**

## Before installing

1. Connect the device to the internet.
2. Open **https://slide.joalvergs.tech** in a supported browser.
3. Confirm that the S.L.I.D.E. dashboard appears.
4. Do not continue if the browser shows a Vercel login page, certificate warning, `404 DEPLOYMENT_NOT_FOUND`, or another error. Contact the project administrator first.

After the first successful visit, the application shell can reopen offline. Live readings, alerts, and synchronization will still require a connection after the backend is integrated.

## Android phone or tablet using Chrome

1. Open **Google Chrome**.
2. Visit **https://slide.joalvergs.tech**.
3. Wait for the dashboard to finish loading.
4. Tap the **three-dot menu** beside the address bar.
5. Select **Install app**, **Install**, or **Add to Home screen**. The wording varies by Chrome version and device manufacturer.
6. Review the app name, then tap **Install**.
7. Return to the Home Screen or app drawer.
8. Tap the **S.L.I.D.E.** icon to open it in its standalone app window.

If Chrome displays an **Install app** button inside the dashboard, that button can be used instead.

Official reference: [Use web apps on Android — Google Chrome Help](https://support.google.com/chrome/answer/9658361/use-progressive-web-apps-android)

### Uninstall on Android

1. Open the device's **Settings**.
2. Select **Apps** or **Applications**.
3. Find **S.L.I.D.E. Field Monitor**.
4. Tap **Uninstall**.

## iPhone using Safari

Use Safari for installation. Opening the link in an in-app browser may hide the required Home Screen option.

1. Open **Safari**.
2. Visit **https://slide.joalvergs.tech**.
3. Wait for the dashboard to load.
4. Tap the **Share** button. Depending on the Safari layout, it may appear in the toolbar or under the page menu.
5. Scroll through the actions and tap **Add to Home Screen**.
6. If shown, enable **Open as Web App**.
7. Keep the name **S.L.I.D.E.**, then tap **Add**.
8. Find the new S.L.I.D.E. icon on the Home Screen and tap it.

If **Add to Home Screen** is missing, scroll to the bottom of the Share menu, select **Edit Actions**, and add it to the list.

Official reference: [Turn a website into an app on iPhone — Apple Support](https://support.apple.com/guide/iphone/iphea86e5236/ios)

### Remove from iPhone

1. Touch and hold the S.L.I.D.E. Home Screen icon.
2. Tap **Remove App** or **Delete Bookmark**.
3. Confirm removal.

## iPad using Safari

1. Open **Safari** on the iPad.
2. Visit **https://slide.joalvergs.tech**.
3. Tap the **Share** button, then tap **More** if necessary.
4. Select **Add to Home Screen**.
5. Enable **Open as Web App** if that option appears.
6. Tap **Add**.
7. Open S.L.I.D.E. from the iPad Home Screen.

The installed icon is added only to the iPad on which these steps are performed.

Official reference: [Turn a website into an app on iPad — Apple Support](https://support.apple.com/guide/ipad/ipad8f1f7a29/ipados)

## Windows using Google Chrome

1. Open **Google Chrome**.
2. Visit **https://slide.joalvergs.tech**.
3. Select the **Install** icon at the right side of the address bar, if visible.
4. If it is not visible, open the **three-dot menu**.
5. Select **Cast, save, and share**, then **Install page as app**.
6. Select **Install** in the confirmation window.
7. Optionally pin S.L.I.D.E. to the taskbar or Start menu when prompted.

Official reference: [Use web apps on a computer — Google Chrome Help](https://support.google.com/chrome/answer/9658361)

## Windows using Microsoft Edge

1. Open **Microsoft Edge**.
2. Visit **https://slide.joalvergs.tech**.
3. Select the **App available** icon at the right side of the address bar, if visible.
4. Otherwise, open the **three-dot menu** and select **Apps**.
5. Select **Install this site as an app**.
6. Confirm the name and select **Install**.
7. Choose whether to pin it to the taskbar, Start menu, or desktop.

Installed web apps can be managed from `edge://apps`.

## macOS using Google Chrome

1. Open **Google Chrome**.
2. Visit **https://slide.joalvergs.tech**.
3. Select the **Install** icon in the address bar, if present.
4. Otherwise, open Chrome's **three-dot menu**.
5. Select **Cast, save, and share**, then **Install page as app**.
6. Select **Install**.
7. Open S.L.I.D.E. from Launchpad, Spotlight, or the Applications area and optionally keep it in the Dock.

Installed Chrome web apps can be managed from `chrome://apps`.

## Chromebook

1. Open **Chrome**.
2. Visit **https://slide.joalvergs.tech**.
3. Select the **Install** icon in the address bar, or open the three-dot menu.
4. Select **Install page as app** and confirm.
5. Open S.L.I.D.E. from the Chromebook Launcher.

To remove it, right-click the app in the Launcher and select **Uninstall**.

## Linux using Chrome or Chromium

1. Open **Chrome** or **Chromium**.
2. Visit **https://slide.joalvergs.tech**.
3. Select the Install icon in the address bar, or open the browser menu.
4. Select **Install page as app**.
5. Confirm installation.
6. Open S.L.I.D.E. from the desktop environment's application launcher.

Browser packaging and desktop integration may differ across Linux distributions.

## Updating the installed app

The PWA checks for updates when it is opened with an internet connection. To force a refresh:

1. Close every open S.L.I.D.E. app window.
2. Reopen **https://slide.joalvergs.tech** in the browser.
3. Reload the page.
4. Close and reopen the installed application.

If an old version remains, clear the site's cached data or uninstall and reinstall the PWA.

## Troubleshooting

### A Vercel login page appears

The production deployment is protected. A project administrator must change Vercel Deployment Protection to **Standard Protection** or **None** before the public can install the app.

### `404 DEPLOYMENT_NOT_FOUND` appears

The domain reaches Vercel but is not assigned to a current deployment. The administrator must attach `slide.joalvergs.tech` to the active production deployment.

### The browser shows a certificate or privacy warning

Do not install or continue. Confirm that the device date and time are correct, then contact the administrator. Vercel may still be provisioning the HTTPS certificate after a DNS or domain change.

### Install or Add to Home Screen is missing

- Confirm that the exact HTTPS address opens successfully.
- On iPhone or iPad, use Safari rather than an embedded browser inside Messenger, Facebook, Gmail, or another app.
- On Android or desktop, use an up-to-date version of Chrome or Edge.
- Reload the page and wait several seconds.
- Check whether the application is already installed.
- Managed school or workplace devices may block web-app installation.

### The app opens but data is old

The current prototype includes demonstration readings. After backend integration, check the displayed last-update time and connectivity status before acting on measurements.

### Offline behavior

The cached interface can open without a connection after one successful online visit. Offline availability does not mean that sensor readings, SMS delivery, or alerts are current. Always verify the timestamp and connection indicator.

## Safety notice

S.L.I.D.E. indicates measured conditions associated with landslide risk. It does not predict whether or when a landslide will occur. Follow official instructions from local disaster-risk authorities during an emergency.
