use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use objc2::{define_class, extern_methods, msg_send, runtime::Bool, ClassType, DefinedClass};
use objc2_app_kit::{NSApp, NSApplication, NSEvent};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol};
use std::cell::Cell;

#[derive(Default)]
pub struct GaiaApplicationIvars {
    handling_send_event: Cell<Bool>,
}

define_class!(
    #[unsafe(super(NSApplication))]
    #[ivars = GaiaApplicationIvars]
    pub struct GaiaApplication;

    impl GaiaApplication {
        #[unsafe(method(sendEvent:))]
        unsafe fn send_event(&self, event: &NSEvent) {
            let was_sending_event = self.is_handling_send_event();
            if !was_sending_event {
                self.set_handling_send_event(true);
            }
            let _: () = msg_send![super(self), sendEvent:event];
            if !was_sending_event {
                self.set_handling_send_event(false);
            }
        }
    }

    unsafe impl CrAppControlProtocol for GaiaApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn _set_handling_send_event(&self, handling_send_event: Bool) {
            self.ivars().handling_send_event.set(handling_send_event);
        }
    }

    unsafe impl CrAppProtocol for GaiaApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn _is_handling_send_event(&self) -> Bool {
            self.ivars().handling_send_event.get()
        }
    }

    unsafe impl CefAppProtocol for GaiaApplication {}
);

impl GaiaApplication {
    extern_methods! {
        #[unsafe(method(sharedApplication))]
        fn shared_application() -> objc2::rc::Retained<Self>;

        #[unsafe(method(setHandlingSendEvent:))]
        fn set_handling_send_event(&self, handling_send_event: bool);

        #[unsafe(method(isHandlingSendEvent))]
        fn is_handling_send_event(&self) -> bool;
    }
}

pub fn setup_application() {
    let _ = GaiaApplication::shared_application();
    assert!(
        NSApp(MainThreadMarker::new().expect("not running on the main thread"))
            .isKindOfClass(GaiaApplication::class())
    );
}
