import Foundation
import Tauri
import UIKit
import WebKit

struct ShareArgs: Decodable { let path: String }
struct UrlArgs: Decodable { let url: String }

class ZentraMobilePlugin: Plugin {
  private weak var webview: WKWebView?
  override func load(webview: WKWebView) { self.webview = webview }

  @objc func shareFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareArgs.self)
    let file = URL(fileURLWithPath: args.path).resolvingSymlinksInPath()
    let root = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"
    var isDirectory: ObjCBool = false
    guard file.path.hasPrefix(root), FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory), !isDirectory.boolValue else { invoke.reject("Document local introuvable"); return }
    DispatchQueue.main.async {
      guard let controller = self.manager.viewController, let webview = self.webview else { invoke.reject("Partage indisponible"); return }
      let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
      sheet.popoverPresentationController?.sourceView = webview
      sheet.popoverPresentationController?.sourceRect = CGRect(x: webview.bounds.midX, y: webview.bounds.midY, width: 1, height: 1)
      controller.present(sheet, animated: true) { invoke.resolve() }
    }
  }

  @objc func openUrl(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(UrlArgs.self)
    guard let url = URL(string: args.url), let scheme = url.scheme, ["https", "mailto"].contains(scheme) else { invoke.reject("Adresse refusée"); return }
    DispatchQueue.main.async {
      UIApplication.shared.open(url, options: [:]) { success in
        if success { invoke.resolve() } else { invoke.reject("Aucune application compatible n’est disponible") }
      }
    }
  }
}

@_cdecl("init_plugin_zentra_mobile")
func initPlugin() -> Plugin { ZentraMobilePlugin() }
