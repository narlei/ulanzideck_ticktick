// ticktick-login — a tiny native login window for the TickTick Focus Ulanzi plugin.
//
// Opens a WKWebView (the WebKit engine already shipped with macOS — no Chromium,
// no download) at the TickTick sign-in page. The user logs in normally (password,
// Google/Apple, captcha, 2FA — it's a real browser engine), and as soon as the
// session cookie `t` appears in the cookie store, we print it to stdout and exit.
//
// WKWebView can read HttpOnly cookies via WKHTTPCookieStore, which `document.cookie`
// cannot — that is the whole trick.
//
// Exit codes: 0 = token printed to stdout · 2 = window closed before login · 3 = timeout.

import Cocoa
import WebKit

let COOKIE_NAME = "t"
let LOGIN_URL = "https://ticktick.com/signin"
let DOMAIN_SUFFIX = "ticktick.com"
let TIMEOUT_SECONDS = 300.0

final class LoginController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var pollTimer: Timer?
    var timeoutTimer: Timer?
    var finished = false

    func applicationDidFinishLaunching(_ note: Notification) {
        // Without a main menu (this is a plain executable, not a .app bundle) the
        // standard Edit shortcuts — including ⌘V paste — never reach the WKWebView.
        installEditMenu()

        let frame = NSRect(x: 0, y: 0, width: 460, height: 720)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Sign in to TickTick"
        window.delegate = self
        window.center()

        // A persistent data store means a still-valid session logs in with no typing —
        // handy for refreshing an expired token in one click.
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
        webView = WKWebView(frame: frame, configuration: config)
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if let url = URL(string: LOGIN_URL) {
            webView.load(URLRequest(url: url))
        }

        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
            self?.pollCookies()
        }
        timeoutTimer = Timer.scheduledTimer(withTimeInterval: TIMEOUT_SECONDS, repeats: false) { [weak self] _ in
            self?.finish(code: 3)
        }
    }

    func installEditMenu() {
        let mainMenu = NSMenu()

        // App menu (gives ⌘Q).
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // Edit menu — the selectors travel the responder chain to the WKWebView.
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    func pollCookies() {
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self, !self.finished else { return }
            for c in cookies where c.name == COOKIE_NAME
                && c.domain.hasSuffix(DOMAIN_SUFFIX)
                && !c.value.isEmpty {
                // Print ONLY the token on stdout so the caller can read it cleanly.
                FileHandle.standardOutput.write(Data((c.value + "\n").utf8))
                self.finish(code: 0)
                return
            }
        }
    }

    func finish(code: Int32) {
        if finished { return }
        finished = true
        pollTimer?.invalidate()
        timeoutTimer?.invalidate()
        exit(code)
    }

    // User closed the window before logging in → cancel.
    func windowWillClose(_ note: Notification) {
        finish(code: 2)
    }
}

let app = NSApplication.shared
let controller = LoginController()
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
