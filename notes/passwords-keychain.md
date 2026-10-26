# Apple Passwords and the login keychain

ArcMod 1.168.0 already contains Chromium's iCloud Keychain passkey code. macOS only runs it for a browser Apple has entitled. A self-signed or ad hoc ArcMod cannot get that entitlement, and it is not on Apple's iCloud Passwords helper allowlist (stock Arc is: `company.thebrowser.Browser`, team `S6N382Y83G`).

This note is what you can turn on yourself, what stays blocked, and how to check each one on your Mac. Nothing here talks to The Browser Company. Login-keychain mode stores one encryption key in your Mac's login keychain. iCloud traffic, when macOS allows it, stays inside Apple's `PasswordManagerBrowserExtensionHelper`.

## What works on a self-signed build

| Goal | Result |
| --- | --- |
| ArcMod's own cookies and saved passwords encrypted with a login-keychain key (`ArcMod Safe Storage`), instead of Chromium's public `mock_password` | Works for the everyday app. A profile left on the test key is moved once, with ArcMod closed, by `bun tools/keychain-profile.ts`. Validation and agent builds stay on the test key. |
| Fill and save website passwords from the Passwords app / iCloud Keychain, the way Safari does | Blocked. Needs Apple's helper, which macOS kills unless the parent is allowlisted or holds the passkey entitlement. |
| Create and use passkeys stored in iCloud Keychain or confirmed with Touch ID | Blocked for the same reason. The engine calls `ASAuthorizationPlatformPublicKeyCredentialProvider` only after it sees `com.apple.developer.web-browser.public-key-credential`. |
| Passkeys on a security key, a phone QR code, or a password-manager extension (1Password, Bitwarden) | Unchanged. They do not need the entitlement. |
| Arc sign-in, Arc sync, CloudKit | Still off. Login-keychain mode does not turn them on. |

Chromium does not put each website password in the keychain. It keeps them in the profile database and encrypts that database with one key. Login-keychain mode puts **that key** in the login keychain under this app's name. It does not copy passwords into iCloud Keychain, and it does not read Arc's `Arc Safe Storage` item.

## 1. Login keychain for ArcMod's own secrets

The everyday app always uses its own login-keychain item. Validation and agent builds always keep the mock key, so they never prompt and must not hold a real session.

A data folder from before this switch is still encrypted with Chromium's public test key. The first launch of the everyday app opens Terminal and runs `bun tools/keychain-profile.ts`, which re-encrypts that folder and leaves `User Data/.arcmod-keychain`. A brand-new data folder is marked immediately and starts on the login keychain.

### Stable signing identity (do this first)

Ad hoc signatures change every rebuild, so macOS asks again for the keychain item and "Always Allow" does not stick. A self-signed certificate is a stable identity. It is not a Developer ID.

```sh
bash tools/setup-signing-identity.sh
bun tools/build-mod.ts --sign-identity "ArcMod Local"
```

The private key is `~/.arcmod/ArcModLocal.key`. Keep it if you want the same identity later. If `codesign` says the certificate is not trusted, open Keychain Access, select **ArcMod Local** in the login keychain, and set **Trust → Code Signing** to **Always Trust**. Then rebuild.

Quit ArcMod before `bun tools/build-mod.ts`. The everyday app is still `/Applications/ArcMod.app`.

### Move an existing profile

Quit ArcMod, then from this repo:

```sh
bun tools/keychain-profile.ts --relaunch --app /Applications/ArcMod.app
```

That re-encrypts `~/Library/Application Support/ArcMod` and reopens ArcMod. `--discard` deletes the test-key cookies and passwords instead of moving them. Do not point this at a validation or agent data folder: those builds stay on the public test key.

There is no switch back to the mock key for the everyday app. That key is public.

### Check it

1. ArcMod → **About this mod…** shows the log path. After a page load it should contain `secret storage: login-keychain (ArcMod Safe Storage)` and, once Chromium asks for the key, `keychain: browser safe storage uses ArcMod Safe Storage`.
2. `test -f "$HOME/Library/Application Support/ArcMod/User Data/.arcmod-keychain" && echo "profile marker exists"`
3. Confirm the item exists without printing the secret:

   ```sh
   security find-generic-password -s "ArcMod Safe Storage" -a "ArcMod" >/dev/null && echo "ArcMod item exists"
   ```

4. Arc's item is a different record. Do not print its secret either:

   ```sh
   security find-generic-password -s "Arc Safe Storage" -a "Arc" >/dev/null && echo "Arc item still exists"
   ```

5. If macOS asks ArcMod to use **Arc Safe Storage**, choose **Deny** and stop. The rewriter missed a lookup, and allowing it would attach ArcMod to Arc's key. **ArcMod Safe Storage** is the item you allow. Choose **Always Allow** only after signing with `ArcMod Local` (or a Developer ID).
6. Sign into a site, save the password when Chromium asks, quit, reopen. The password should still be offered. Cookies for sites you were signed into should still work after the migration.
7. `tools/run-mod.sh` omits `--use-mock-keychain` for the everyday app. Validation and agent launches still pass it.

Import from Arc re-encrypts the copy for `ArcMod Safe Storage`. Arc's item is only read, and only to decrypt that copy. Choose **Allow**, not **Always Allow**, for Arc's prompt. Import into the everyday app only.

## 2 and 3. iCloud Passwords and iCloud Keychain passkeys

These two are the same gate.

- Passkeys: Chromium's `ASAuthorizationWebBrowserPublicKeyCredentialManager` runs only when the process entitlement `com.apple.developer.web-browser.public-key-credential` is present. Apple grants that to an organization Account Holder for a general-purpose browser. A self-signed entitlement is ignored, and embedding it makes Chromium try iCloud Keychain and then fail, including the phone and security-key fallbacks. Do not add the key until Apple has approved it.
- Passwords: Apple's iCloud Passwords extension talks to `PasswordManagerBrowserExtensionHelper`. Since macOS 15.4 the helper has a parent launch constraint. The parent must be an allowlisted bundle id and team, or hold that same entitlement. ArcMod's id is `company.thebrowser.Browser.mod`. Re-signing drops team `S6N382Y83G`. macOS kills the helper (`SIGKILL`) and the extension cannot fill or save.

There is no public API that lets an arbitrary browser read or write iCloud Keychain passwords for arbitrary sites. `ASAuthorizationPasswordProvider` and the old shared-web-credential calls only see domains in an associated-domains entitlement plus that site's `apple-app-site-association` file. Putting each site's password into the login keychain ourselves would not be the Passwords app, and iCloud Keychain items are not readable from an unentitled app.

### Install the manifest anyway

The manifest is the file Chromium needs before it will launch Apple's helper. Installing it is safe. It does not make a self-signed build work. It is the piece you will already have if the signature later qualifies.

**ArcMod → Set Up iCloud Passwords…**, or:

```sh
bun tools/icloud-passwords.ts --install --doctor --open-store --app /Applications/ArcMod.app
```

This writes `com.apple.passwordmanager.json` under `~/Library/Application Support/ArcMod/` (and `User Data/NativeMessagingHosts/`). It does not write into `~/Library/Application Support/Arc`. The doctor prints `Status: blocked` for a self-signed build. That is the expected result.

Then install Apple's **iCloud Passwords** extension from the Chrome Web Store (id `pejdijmoenmkgeppbflobdenhhabjlaj`). On a blocked build the extension cannot connect. That confirms the diagnosis. It is not an ArcMod bug to patch around: the kill comes from the helper's signature constraint.

### When you have a Developer ID Apple has approved

```sh
# Add the passkey key to the App ID in the developer portal first.
bun tools/build-mod.ts \
  --sign-identity "Developer ID Application: Your Name (TEAMID)" \
  --entitlements resources/ArcMod.passkeys.entitlements.plist \
  --hardened-runtime \
  --timestamp
```

`resources/ArcMod.hardened.entitlements.plist` is only `com.apple.security.cs.disable-library-validation`, for loading `ArcMod.dylib` under the hardened runtime. `resources/ArcMod.passkeys.entitlements.plist` adds the passkey entitlement. The build prints a warning whenever that key is embedded. Default builds do not use either file: they stay ad hoc, with no hardened runtime and no restricted entitlements.

Notarize the app with your Apple account if you want it to launch without Gatekeeper blocks. Notarization is not a substitute for the entitlement.

Re-run the doctor. `Status: confirm` means the signature has the right shape. It does not mean Apple has approved the capability. Then:

1. System Settings → General → AutoFill & Passwords. A browser only shows up for passkeys when the entitlement is real.
2. On a site whose password is in the Passwords app, the iCloud Passwords extension should offer to fill, and after a new login it should offer to save. The password must not appear in ArcMod's log.
3. On <https://webauthn.io>, register a passkey. The sheet should offer iCloud Keychain / Touch ID, not only the QR code. Sign in again with that passkey.
4. A security key and "Use a phone or tablet" should still work.
5. `codesign -d --entitlements :- /Applications/ArcMod.app` shows the passkey key. `codesign -dv` shows your team id and `runtime`.

If the app is killed at launch after adding the passkey plist, Apple has not authorized the entitlement for that signature. Rebuild without that plist. Phone and security-key passkeys work again once the key is gone.

## What this VM did not run

These steps need macOS, Arc 1.168.0, and your login keychain. The Linux checkout covers the decision table, the profile re-encryption, the manifest JSON, the codesign report, and the C matcher that decides which keychain names get rewritten. It does not launch ArcMod, sign an app, or talk to the Passwords app.
