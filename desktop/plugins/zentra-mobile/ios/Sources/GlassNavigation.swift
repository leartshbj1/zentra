import UIKit

/// Native controls above the WKWebView. Document content keeps an opaque surface.
@available(iOS 26.0, *)
final class GlassNavigation: UIStackView {
  private let destinations = [
    ("dashboard", "Accueil", "house"), ("projects", "Projets", "folder"),
    ("quotes", "Ventes", "doc.text"), ("menu", "Menu", "line.3.horizontal")
  ]
  var onSelect: ((String) -> Void)?
  private var requestedVisible = false
  private var keyboardVisible = false
  private var observers: [NSObjectProtocol] = []

  init(host: UIView) {
    super.init(frame: .zero)
    axis = .horizontal
    spacing = 6
    distribution = .fillEqually
    translatesAutoresizingMaskIntoConstraints = false
    accessibilityIdentifier = "zentra.native.navigation"
    for (id, title, symbol) in destinations {
      let button = UIButton(configuration: .glass())
      button.accessibilityIdentifier = "zentra.native.\(id)"
      button.accessibilityLabel = id == "menu" ? "Tous les modules" : title
      button.addAction(UIAction { [weak self] _ in self?.onSelect?(id) }, for: .touchUpInside)
      var config = button.configuration!
      config.title = title
      config.image = UIImage(systemName: symbol)
      button.configuration = config
      addArrangedSubview(button)
    }
    host.addSubview(self)
    let width = widthAnchor.constraint(equalTo: host.safeAreaLayoutGuide.widthAnchor, constant: -24)
    width.priority = .defaultHigh
    NSLayoutConstraint.activate([
      centerXAnchor.constraint(equalTo: host.safeAreaLayoutGuide.centerXAnchor),
      bottomAnchor.constraint(equalTo: host.safeAreaLayoutGuide.bottomAnchor, constant: -8),
      width, widthAnchor.constraint(lessThanOrEqualToConstant: 480),
      heightAnchor.constraint(equalToConstant: 64)
    ])
    observers.append(NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
      self?.keyboardVisible = true
      self?.updateVisibility()
    })
    observers.append(NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
      self?.keyboardVisible = false
      self?.updateVisibility()
    })
    isHidden = true
  }

  required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }

  func configure(selected: String, visible: Bool) {
    requestedVisible = visible
    for (index, view) in arrangedSubviews.enumerated() {
      guard let button = view as? UIButton else { continue }
      let (id, title, symbol) = destinations[index]
      let active = id == selected
      var config: UIButton.Configuration = active ? .prominentGlass() : .glass()
      config.title = title
      config.image = UIImage(systemName: symbol)
      config.imagePlacement = .top
      config.imagePadding = 4
      config.cornerStyle = .capsule
      config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 2, bottom: 8, trailing: 2)
      config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 19, weight: active ? .semibold : .regular)
      config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
        var outgoing = incoming
        outgoing.font = UIFontMetrics(forTextStyle: .caption1).scaledFont(for: .systemFont(ofSize: 11, weight: .medium), maximumPointSize: 15)
        return outgoing
      }
      // Keep secondary controls legible as the system changes the glass appearance.
      button.tintColor = active ? UIColor(red: 0.14, green: 0.36, blue: 0.25, alpha: 1) : .label
      button.configuration = config
      button.accessibilityTraits = active ? [.button, .selected] : [.button]
      button.showsLargeContentViewer = true
      button.largeContentTitle = title
      button.largeContentImage = UIImage(systemName: symbol)
      if button.interactions.allSatisfy({ !($0 is UILargeContentViewerInteraction) }) {
        button.addInteraction(UILargeContentViewerInteraction())
      }
    }
    updateVisibility()
  }

  private func updateVisibility() {
    isHidden = !requestedVisible || keyboardVisible
    accessibilityElementsHidden = isHidden
  }
}
