//! AppKit navigation above the web content. NSGlassEffectView is resolved at
//! runtime, so pre-Tahoe installations keep the complete HTML navigation.
use serde_json::{json, Value};

#[tauri::command]
pub async fn configure_macos_navigation(
    window: tauri::WebviewWindow,
    selected: String,
    visible: bool,
    on_navigate: tauri::ipc::Channel<Value>,
) -> Result<Value, String> {
    if !["dashboard", "projects", "quotes", "menu"].contains(&selected.as_str()) {
        return Err("Navigation inconnue".into());
    }
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            app.run_on_main_thread(move || {
                let result = native::configure(&window, &selected, visible, on_navigate);
                let _ = sender.send(result);
            })
            .map_err(|error| error.to_string())?;
            receiver.recv().map_err(|error| error.to_string())?
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, selected, visible, on_navigate);
        Ok(json!({"available": false}))
    }
}

#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
pub fn hide_on_reload() {
    native::hide();
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2::rc::Retained;
    use objc2::runtime::AnyClass;
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSControlSize, NSLayoutConstraint, NSSegmentDistribution, NSSegmentStyle,
        NSSegmentedControl, NSView, NSWindow,
    };
    use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSRect, NSString};
    use std::cell::{Cell, RefCell};

    const DESTINATIONS: [&str; 4] = ["dashboard", "projects", "quotes", "menu"];
    struct Callbacks {
        channel: RefCell<tauri::ipc::Channel<Value>>,
        visible: Cell<bool>,
    }
    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Callbacks]
        struct NavigationAction;
        unsafe impl NSObjectProtocol for NavigationAction {}
        impl NavigationAction {
            #[unsafe(method(navigate:))]
            fn navigate(&self, control: &NSSegmentedControl) {
                if !self.ivars().visible.get() { return; }
                let index = control.selectedSegment();
                if let Some(id) = usize::try_from(index).ok().and_then(|index| DESTINATIONS.get(index)) {
                    if self.ivars().channel.borrow().send(json!({"id": id})).is_err() {
                        self.ivars().visible.set(false);
                        control.setEnabled(false);
                    }
                }
            }
        }
    );
    impl NavigationAction {
        fn new(mtm: MainThreadMarker, channel: tauri::ipc::Channel<Value>) -> Retained<Self> {
            let allocated = Self::alloc(mtm).set_ivars(Callbacks {
                channel: RefCell::new(channel),
                visible: Cell::new(false),
            });
            // NSObject initialization of this main-thread-only subclass.
            unsafe { msg_send![super(allocated), init] }
        }
    }

    struct Dock {
        window_id: usize,
        glass: Retained<NSView>,
        control: Retained<NSSegmentedControl>,
        action: Retained<NavigationAction>,
    }
    impl Drop for Dock {
        fn drop(&mut self) {
            self.glass.removeFromSuperview();
        }
    }
    thread_local! { static DOCK: RefCell<Option<Dock>> = const { RefCell::new(None) }; }

    pub fn hide() {
        if MainThreadMarker::new().is_none() {
            return;
        }
        DOCK.with_borrow(|dock| {
            if let Some(dock) = dock {
                dock.action.ivars().visible.set(false);
                dock.glass.setHidden(true);
            }
        });
    }

    pub fn configure(
        window: &tauri::WebviewWindow,
        selected: &str,
        visible: bool,
        channel: tauri::ipc::Channel<Value>,
    ) -> Result<Value, String> {
        let mtm = MainThreadMarker::new().ok_or("Navigation hors du thread principal")?;
        // Dynamic lookup avoids referencing a class symbol absent on macOS <26.
        let Some(glass_class) = AnyClass::get(c"NSGlassEffectView") else {
            return Ok(json!({"available": false}));
        };
        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        if pointer.is_null() {
            return Ok(json!({"available": false}));
        }
        // Tauri owns this NSWindow; this entire operation executes on its UI thread.
        let native_window = unsafe { &*pointer.cast::<NSWindow>() };
        let Some(host) = native_window.contentView() else {
            return Ok(json!({"available": false}));
        };
        DOCK.with_borrow_mut(|slot| {
            if slot
                .as_ref()
                .is_some_and(|dock| dock.window_id != pointer as usize)
            {
                *slot = None;
            }
            if slot.is_none() {
                let action = NavigationAction::new(mtm, channel.clone());
                let control =
                    NSSegmentedControl::initWithFrame(NSSegmentedControl::alloc(mtm), NSRect::ZERO);
                control.setSegmentCount(4);
                control.setSegmentStyle(NSSegmentStyle::Automatic);
                control.setSegmentDistribution(NSSegmentDistribution::FillEqually);
                control.setControlSize(NSControlSize::Large);
                for (index, label) in ["Accueil", "Projets", "Ventes", "Menu"].iter().enumerate() {
                    let label = NSString::from_str(label);
                    control.setLabel_forSegment(&label, index as isize);
                    control.setToolTip_forSegment(Some(&label), index as isize);
                }
                // The retained action object outlives the control's non-owning target.
                unsafe {
                    control.setTarget(Some(&action));
                    control.setAction(Some(sel!(navigate:)));
                }
                let content = NSView::initWithFrame(NSView::alloc(mtm), NSRect::ZERO);
                content.addSubview(&control);
                // This is the official AppKit material, not an NSVisualEffectView
                // approximation. Only contentView belongs inside its glass layer.
                let glass: Retained<NSView> = unsafe {
                    let allocated: objc2::rc::Allocated<NSView> = msg_send![glass_class, alloc];
                    let glass: Retained<NSView> = msg_send![allocated, initWithFrame: NSRect::ZERO];
                    let _: () = msg_send![&glass, setCornerRadius: 28.0f64];
                    let _: () = msg_send![&glass, setContentView: &*content];
                    glass
                };
                glass.setHidden(true);
                host.addSubview(&glass);
                glass.setTranslatesAutoresizingMaskIntoConstraints(false);
                control.setTranslatesAutoresizingMaskIntoConstraints(false);
                let constraints = [
                    glass
                        .centerXAnchor()
                        .constraintEqualToAnchor(&host.centerXAnchor()),
                    glass.bottomAnchor().constraintEqualToAnchor_constant(
                        &host.safeAreaLayoutGuide().bottomAnchor(),
                        -14.0,
                    ),
                    glass.widthAnchor().constraintEqualToConstant(360.0),
                    glass.heightAnchor().constraintEqualToConstant(58.0),
                    control
                        .leadingAnchor()
                        .constraintEqualToAnchor_constant(&content.leadingAnchor(), 10.0),
                    control
                        .trailingAnchor()
                        .constraintEqualToAnchor_constant(&content.trailingAnchor(), -10.0),
                    control
                        .topAnchor()
                        .constraintEqualToAnchor_constant(&content.topAnchor(), 8.0),
                    control
                        .bottomAnchor()
                        .constraintEqualToAnchor_constant(&content.bottomAnchor(), -8.0),
                ];
                NSLayoutConstraint::activateConstraints(&NSArray::from_retained_slice(
                    &constraints,
                ));
                *slot = Some(Dock {
                    window_id: pointer as usize,
                    glass,
                    control,
                    action,
                });
            }
            if let Some(dock) = slot {
                *dock.action.ivars().channel.borrow_mut() = channel;
                dock.action.ivars().visible.set(visible);
                dock.control.setEnabled(visible);
                if let Some(index) = DESTINATIONS.iter().position(|id| *id == selected) {
                    dock.control.setSelectedSegment(index as isize);
                }
                dock.glass.setHidden(!visible);
            }
            Ok(json!({"available": true}))
        })
    }
}
