//! A Mind's life-state as her picture shows it. The token's SVG is drawn by `glossy.rs`
//! from this state and the Mind's look; the contract derives it from her food and flags.

/// The life-state the face shows. Derived in the contract from balance + flags.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Appearance {
    Full,
    Content,
    Hungry,
    Starving,
    Asleep,
    Ghost,
}
