use crossterm::event::{self, Event, KeyEvent};
use std::sync::mpsc;

#[derive(Debug)]
pub enum InputEvent {
    Key(KeyEvent),
}

/// Spawns a dedicated OS thread that blocks on crossterm and forwards key
/// events over a channel, so the async main loop never blocks on input.
pub fn input_thread(tx: mpsc::Sender<InputEvent>) {
    std::thread::spawn(move || loop {
        if let Ok(Event::Key(k)) = event::read() {
            if tx.send(InputEvent::Key(k)).is_err() {
                break;
            }
        }
    });
}
