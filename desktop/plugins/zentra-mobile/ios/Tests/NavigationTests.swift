import XCTest
import UIKit
@testable import tauri_plugin_zentra_mobile

@available(iOS 26.0, *)
@MainActor
final class NavigationTests: XCTestCase {
  func testNavigationLayoutActionsAndKeyboard() {
    let host = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 568))
    let scrollView = UIScrollView(frame: host.bounds)
    host.addSubview(scrollView)
    let dock = GlassNavigation(host: host, scrollView: scrollView)
    var destination: String?
    dock.onSelect = { destination = $0 }
    dock.configure(selected: "projects", visible: true)
    host.layoutIfNeeded()
    XCTAssertFalse(dock.isHidden)
    let edge = dock.interactions.compactMap { $0 as? UIScrollEdgeElementContainerInteraction }.first
    XCTAssertTrue(edge?.scrollView === scrollView)
    XCTAssertEqual(edge?.edge, .bottom)
    dock.configure(selected: "projects", visible: true)
    XCTAssertEqual(dock.interactions.filter { $0 is UIScrollEdgeElementContainerInteraction }.count, 1)
    XCTAssertEqual(dock.arrangedSubviews.count, 4)
    XCTAssertGreaterThanOrEqual(dock.frame.minX, 0)
    XCTAssertLessThanOrEqual(dock.frame.maxX, host.bounds.width)
    for view in dock.arrangedSubviews {
      XCTAssertGreaterThanOrEqual(view.bounds.width, 44)
      XCTAssertGreaterThanOrEqual(view.bounds.height, 44)
    }
    let projects = dock.arrangedSubviews[1] as! UIButton
    XCTAssertTrue(projects.accessibilityTraits.contains(.selected))
    let home = dock.arrangedSubviews[0] as! UIButton
    for style in [UIUserInterfaceStyle.light, .dark] {
      let traits = UITraitCollection(userInterfaceStyle: style)
      XCTAssertEqual(home.tintColor.resolvedColor(with: traits), UIColor.label.resolvedColor(with: traits))
    }
    projects.sendActions(for: .touchUpInside)
    XCTAssertEqual(destination, "projects")
    NotificationCenter.default.post(name: UIResponder.keyboardWillShowNotification, object: nil)
    XCTAssertTrue(dock.isHidden)
    XCTAssertNil(edge?.view, "Hidden controls must not leave a scroll edge treatment over a form")
    dock.configure(selected: "quotes", visible: true)
    XCTAssertTrue(dock.isHidden, "Updates must not reopen controls above the keyboard")
    XCTAssertFalse(projects.accessibilityTraits.contains(.selected))
    XCTAssertEqual(projects.tintColor, UIColor.label, "Previously selected controls return to the system text color")
    NotificationCenter.default.post(name: UIResponder.keyboardWillHideNotification, object: nil)
    XCTAssertFalse(dock.isHidden)
    XCTAssertTrue(edge?.view === dock)
    dock.configure(selected: "quotes", visible: false)
    XCTAssertTrue(dock.isHidden)
    XCTAssertTrue(dock.accessibilityElementsHidden)
    XCTAssertNil(edge?.view)
  }

  func testSelectionAdaptsToAppearanceAndContrast() {
    let host = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    let scrollView = UIScrollView(frame: host.bounds)
    host.addSubview(scrollView)
    let dock = GlassNavigation(host: host, scrollView: scrollView)
    dock.configure(selected: "projects", visible: true)
    let selected = dock.arrangedSubviews[1] as! UIButton
    var variants: [UIColor] = []
    for style in [UIUserInterfaceStyle.light, .dark] {
      for contrast in [UIAccessibilityContrast.normal, .high] {
        let traits = UITraitCollection(traitsFrom: [
          UITraitCollection(userInterfaceStyle: style),
          UITraitCollection(accessibilityContrast: contrast)
        ])
        let tint = selected.tintColor.resolvedColor(with: traits)
        XCTAssertFalse(variants.contains(tint), "Each appearance and contrast has a distinct green")
        variants.append(tint)
      }
    }
    dock.configure(selected: "dashboard", visible: true)
    XCTAssertEqual(selected.tintColor, UIColor.label)
  }
}
