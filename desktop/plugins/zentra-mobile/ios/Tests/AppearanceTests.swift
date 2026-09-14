import XCTest
import UIKit
import WebKit
@testable import tauri_plugin_zentra_mobile

@MainActor
final class AppearanceTests: XCTestCase {
  private func assertColor(_ actual: UIColor?, _ expected: UIColor, file: StaticString = #filePath, line: UInt = #line) {
    guard let actual else { XCTFail("Missing background colour", file: file, line: line); return }
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    var expectedRed: CGFloat = 0, expectedGreen: CGFloat = 0, expectedBlue: CGFloat = 0, expectedAlpha: CGFloat = 0
    // WebKit returns an equivalent CGColor-backed UIColor, which is not
    // object-equal to the extended-sRGB UIColor originally assigned to it.
    XCTAssertTrue(actual.getRed(&red, green: &green, blue: &blue, alpha: &alpha), file: file, line: line)
    XCTAssertTrue(expected.getRed(&expectedRed, green: &expectedGreen, blue: &expectedBlue, alpha: &expectedAlpha), file: file, line: line)
    for (value, target) in zip([red, green, blue, alpha], [expectedRed, expectedGreen, expectedBlue, expectedAlpha]) {
      XCTAssertEqual(value, target, accuracy: 0.0001, file: file, line: line)
    }
  }

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
      assertColor(controller.view.backgroundColor, canvas)
      assertColor(webview.backgroundColor, canvas)
      assertColor(webview.scrollView.backgroundColor, canvas)
      if #available(iOS 15.0, *) { assertColor(webview.underPageBackgroundColor, canvas) }
    }
    AppAppearance.apply(appearance: "system", dark: false, controller: controller, webview: webview)
    XCTAssertEqual(controller.overrideUserInterfaceStyle, .unspecified)
    XCTAssertEqual(window.overrideUserInterfaceStyle, .unspecified)
    window.isHidden = true
  }
}
