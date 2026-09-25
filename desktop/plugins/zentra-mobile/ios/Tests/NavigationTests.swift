import XCTest
import UIKit
@testable import tauri_plugin_zentra_mobile

@available(iOS 26.0, *)
@MainActor
final class NavigationTests: XCTestCase {
  func testFivePersonalShortcutsKeepTargetsAndReplaceActions() {
    let host = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 568))
    let scroll = UIScrollView(frame: host.bounds)
    host.addSubview(scroll)
    let dock = GlassNavigation(host: host, scrollView: scroll)
    var selected: String?
    dock.onSelect = { selected = $0 }
    var items = [NavigationItem(id: "dashboard", label: "Startseite"), NavigationItem(id: "accounting", label: "Buchhaltung"), NavigationItem(id: "invoices", label: "Rechnungen"), NavigationItem(id: "automation", label: "Automation"), NavigationItem(id: "menu", label: "Menü")]
    dock.configure(selected: "accounting", visible: true, items: items)
    host.layoutIfNeeded()
    XCTAssertEqual(dock.arrangedSubviews.count, 5)
    for (index, view) in dock.arrangedSubviews.enumerated() {
      let button = view as! UIButton
      XCTAssertGreaterThanOrEqual(button.bounds.width, 44)
      XCTAssertGreaterThanOrEqual(button.bounds.height, 44)
      XCTAssertEqual(button.accessibilityLabel, items[index].label)
      button.sendActions(for: .touchUpInside)
      XCTAssertEqual(selected, items[index].id)
    }
    let stable = dock.arrangedSubviews[0]
    dock.configure(selected: "invoices", visible: true, items: items)
    XCTAssertTrue(stable === dock.arrangedSubviews[0], "Selection changes preserve the UIKit controls")
    items[3] = NavigationItem(id: "agenda", label: "Kalender")
    dock.configure(selected: "agenda", visible: true, items: items)
    let agenda = dock.arrangedSubviews[3] as! UIButton
    XCTAssertTrue(agenda.accessibilityTraits.contains(.selected))
    agenda.sendActions(for: .touchUpInside)
    XCTAssertEqual(selected, "agenda")
  }
  func testVisibleButtonsReceiveTouchesAfterRepeatedConfiguration() {
    UIView.setAnimationsEnabled(false)
    defer { UIView.setAnimationsEnabled(true) }
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    let controller = UIViewController()
    window.rootViewController = controller
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    let host = controller.view!
    let scroll = UIScrollView(frame: host.bounds)
    host.addSubview(scroll)
    let dock = GlassNavigation(host: host, scrollView: scroll)
    var selected: [String] = []
    dock.onSelect = { selected.append($0) }
    let ids = ["dashboard", "projects", "quotes", "menu"]
    for _ in 0..<3 {
      for (index, id) in ids.enumerated() {
        dock.configure(selected: id, visible: true)
        host.layoutIfNeeded()
        let button = dock.arrangedSubviews[index] as! UIButton
        let point = button.convert(CGPoint(x: button.bounds.midX, y: button.bounds.midY), to: window)
        let touched = window.hitTest(point, with: nil)
        XCTAssertTrue(touched === button || touched?.isDescendant(of: button) == true, "Touch must reach \(id)")
        button.sendActions(for: .touchUpInside)
        XCTAssertEqual(selected.last, id)
        let count = selected.count
        dock.configure(selected: id, visible: false)
        button.sendActions(for: .touchUpInside)
        XCTAssertEqual(selected.count, count)
      }
    }
    XCTAssertEqual(selected, ids + ids + ids)
  }
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
