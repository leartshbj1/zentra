import XCTest
import UIKit
@testable import tauri_plugin_zentra_mobile

@available(iOS 26.0, *)
@MainActor
final class NavigationTests: XCTestCase {
  func testNavigationLayoutActionsAndKeyboard() {
    let host = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 568))
    let dock = GlassNavigation(host: host)
    var destination: String?
    dock.onSelect = { destination = $0 }
    dock.configure(selected: "projects", visible: true)
    host.layoutIfNeeded()
    XCTAssertFalse(dock.isHidden)
    XCTAssertEqual(dock.arrangedSubviews.count, 4)
    XCTAssertGreaterThanOrEqual(dock.frame.minX, 0)
    XCTAssertLessThanOrEqual(dock.frame.maxX, host.bounds.width)
    for view in dock.arrangedSubviews {
      XCTAssertGreaterThanOrEqual(view.bounds.width, 44)
      XCTAssertGreaterThanOrEqual(view.bounds.height, 44)
    }
    let projects = dock.arrangedSubviews[1] as! UIButton
    XCTAssertTrue(projects.accessibilityTraits.contains(.selected))
    projects.sendActions(for: .touchUpInside)
    XCTAssertEqual(destination, "projects")
    NotificationCenter.default.post(name: UIResponder.keyboardWillShowNotification, object: nil)
    XCTAssertTrue(dock.isHidden)
    dock.configure(selected: "quotes", visible: true)
    XCTAssertTrue(dock.isHidden, "Updates must not reopen controls above the keyboard")
    NotificationCenter.default.post(name: UIResponder.keyboardWillHideNotification, object: nil)
    XCTAssertFalse(dock.isHidden)
    dock.configure(selected: "quotes", visible: false)
    XCTAssertTrue(dock.isHidden)
    XCTAssertTrue(dock.accessibilityElementsHidden)
  }
}
