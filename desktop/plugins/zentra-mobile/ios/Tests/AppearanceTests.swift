import XCTest
import UIKit
import WebKit
@testable import tauri_plugin_zentra_mobile

@MainActor
final class AppearanceTests: XCTestCase {
  func testReturningToLightResetsEveryNativeSurface() {
    let controller = UIViewController()
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    window.rootViewController = controller
    window.makeKeyAndVisible()
    let webview = WKWebView(frame: window.bounds)
    controller.view.addSubview(webview)
    for dark in [true, false, true, false] {
      AppAppearance.apply(appearance: dark ? "dark" : "light", dark: dark, controller: controller, webview: webview)
      let canvas = dark ? UIColor(red: 20/255, green: 20/255, blue: 22/255, alpha: 1) : UIColor(red: 245/255, green: 245/255, blue: 247/255, alpha: 1)
      XCTAssertEqual(controller.overrideUserInterfaceStyle, dark ? .dark : .light)
      XCTAssertEqual(window.overrideUserInterfaceStyle, dark ? .dark : .light)
      XCTAssertEqual(controller.view.backgroundColor, canvas)
      XCTAssertEqual(webview.backgroundColor, canvas)
      XCTAssertEqual(webview.scrollView.backgroundColor, canvas)
      if #available(iOS 15.0, *) { XCTAssertEqual(webview.underPageBackgroundColor, canvas) }
    }
    AppAppearance.apply(appearance: "system", dark: false, controller: controller, webview: webview)
    XCTAssertEqual(controller.overrideUserInterfaceStyle, .unspecified)
    XCTAssertEqual(window.overrideUserInterfaceStyle, .unspecified)
    window.isHidden = true
  }
}
