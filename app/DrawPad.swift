// DrawPad.app: a native window for boards (macOS WebKit), so the board isn't a Chrome window.
// Built by `drawpad app` with swiftc; no dependencies. One window per board (keyed by its local port).
// Opened with a board URL (`open -a DrawPad <url>`, what `drawpad open` does) or with none (Dock/Spotlight):
// then it asks the CLI for the most recent board.
import Cocoa
import WebKit

// Written into Info.plist by `drawpad app`.
let node = Bundle.main.object(forInfoDictionaryKey: "DrawPadNode") as? String ?? ""
let cli = Bundle.main.object(forInfoDictionaryKey: "DrawPadCLI") as? String ?? ""

final class Board: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
  let window: NSWindow
  let web: WKWebView
  var port: Int
  var titleObs: NSKeyValueObservation?

  init(url: URL) {
    port = url.port ?? 0
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()
    web = WKWebView(frame: .zero, configuration: cfg)
    web.isInspectable = true
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    super.init()
    web.navigationDelegate = self
    web.uiDelegate = self
    window.contentView = web
    window.delegate = self
    window.title = "DrawPad"
    window.tabbingMode = .disallowed
    window.isReleasedWhenClosed = false
    window.setFrameAutosaveName("DrawPad board \(port)")
    if !window.setFrameUsingName("DrawPad board \(port)") { window.center() }
    titleObs = web.observe(\.title) { [weak self] w, _ in
      if let t = w.title, !t.isEmpty { self?.window.title = t }
      if let p = w.url?.port { self?.port = p }
    }
    web.load(URLRequest(url: url))
    window.makeKeyAndOrderFront(nil)
  }

  // Only the local board loads here; any other link opens in the default browser.
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let u = a.request.url, u.host != "127.0.0.1", u.scheme != "about" {
      NSWorkspace.shared.open(u); return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
    if let u = a.request.url { NSWorkspace.shared.open(u) }
    return nil
  }
  func webViewDidClose(_ w: WKWebView) { window.close() }
  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
  }
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }
  // The server restarts when DrawPad's code changes: retry instead of showing an error page.
  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { w.reload() }
  }
  func windowWillClose(_ n: Notification) { App.shared.boards.removeAll { $0 === self } }
}

final class App: NSObject, NSApplicationDelegate {
  static let shared = App()
  var boards: [Board] = []
  var gotURL = false

  func open(_ url: URL) {
    gotURL = true
    if let b = boards.first(where: { $0.port == url.port }) { b.window.makeKeyAndOrderFront(nil); return }
    boards.append(Board(url: url))
    NSApp.activate(ignoringOtherApps: true)
  }
  func application(_ a: NSApplication, open urls: [URL]) { urls.forEach(open) }

  func applicationDidFinishLaunching(_ n: Notification) {
    menus()
    // Launched without a URL (Dock, Spotlight): open the most recent board.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { if !self.gotURL { self.recent() } }
  }
  func applicationShouldHandleReopen(_ a: NSApplication, hasVisibleWindows v: Bool) -> Bool { if !v { recent() }; return true }
  func applicationShouldTerminateAfterLastWindowClosed(_ a: NSApplication) -> Bool { true }

  func recent() {
    guard !node.isEmpty else { return }
    DispatchQueue.global().async {
      let p = Process(), out = Pipe()
      p.executableURL = URL(fileURLWithPath: node)
      p.arguments = ["--disable-warning=ExperimentalWarning", cli, "recent"]
      p.standardOutput = out
      try? p.run(); p.waitUntilExit()
      let s = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      DispatchQueue.main.async {
        if let u = URL(string: s), u.scheme == "http" { self.open(u) }
        else { let a = NSAlert(); a.messageText = "No DrawPad boards yet"; a.informativeText = "Run `drawpad open` inside a project first."; a.runModal(); NSApp.terminate(nil) }
      }
    }
  }

  func menus() {
    let main = NSMenu()
    func sub(_ title: String, _ items: [NSMenuItem]) { let m = NSMenu(title: title); items.forEach(m.addItem); let i = NSMenuItem(); i.submenu = m; main.addItem(i) }
    func item(_ t: String, _ s: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem { let i = NSMenuItem(title: t, action: s, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i }
    sub("DrawPad", [item("Hide DrawPad", #selector(NSApplication.hide(_:)), "h"), item("Quit DrawPad", #selector(NSApplication.terminate(_:)), "q")])
    // No Undo/Redo here: the board handles ⌘Z itself. Cut/Copy/Paste go to the page as clipboard events.
    sub("Edit", [item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"),
                 item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a")])
    sub("View", [item("Reload", #selector(WKWebView.reload(_:)), "r")])
    sub("Window", [item("Minimize", #selector(NSWindow.miniaturize(_:)), "m"), item("Close", #selector(NSWindow.performClose(_:)), "w")])
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.delegate = App.shared
app.run()
