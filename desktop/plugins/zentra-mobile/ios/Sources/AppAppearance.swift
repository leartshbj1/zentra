import UIKit
import WebKit

enum AppAppearance {
  static func apply(appearance: String, dark: Bool, controller: UIViewController?, webview: WKWebView?) {
    let style: UIUserInterfaceStyle = appearance == "system" ? .unspecified : appearance == "dark" ? .dark : .light
    // Match the web canvas at the safe areas and during elastic scrolling.
    let canvas = dark
      ? UIColor(red: 20/255, green: 20/255, blue: 22/255, alpha: 1)
      : UIColor(red: 245/255, green: 245/255, blue: 247/255, alpha: 1)
    controller?.overrideUserInterfaceStyle = style
    controller?.view.window?.overrideUserInterfaceStyle = style
    controller?.view.backgroundColor = canvas
    webview?.backgroundColor = canvas
    webview?.scrollView.backgroundColor = canvas
    if #available(iOS 15.0, *) { webview?.underPageBackgroundColor = canvas }
    controller?.setNeedsStatusBarAppearanceUpdate()
  }
}
