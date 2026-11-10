//! Mind traits — rolled once at hatch from block randomness (`env::random_seed()`),
//! immutable thereafter. Pure logic so it is unit-tested without near-sdk.
//!
//! The mouth is NOT a trait: it is derived from the hunger state at render time.
//! Temperament picks the default colour tone when the keeper chose no look
//! (`glossy::look_from_traits`).

/// Counts of each visual/behaviour dial.
pub const N_TEMPERAMENT: u8 = 8; // shy, bold, philosopher, grouch, dreamer, pedant, joker, melancholic
pub const N_PASSION: u8 = 8; // stars, coffee, poetry, music, cinema, games, travel, ocean
pub const N_SPEECH: u8 = 5; // speech habits / verbal tics
pub const N_BODY: u8 = 6;
pub const N_EYES: u8 = 8;
pub const N_ACCESSORY: u8 = 10;
pub const N_PATTERN: u8 = 4;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Traits {
    pub temperament: u8, // 0..N_TEMPERAMENT ; also the palette index (visual)
    pub passion: u8,     // 0..N_PASSION ; behavioural only — shapes the AI voice, not the art
    pub speech: u8,      // 0..N_SPEECH ; behavioural only — verbal tics, not the art
    pub body: u8,        // 0..N_BODY
    pub eyes: u8,        // 0..N_EYES
    pub accessory: u8,   // 0..N_ACCESSORY
    pub pattern: u8,     // 0..N_PATTERN
}

/// Deterministically roll traits from a random seed (>= 7 bytes; `random_seed` gives 32).
/// Each dial uses its own seed byte so dials are independent.
pub fn derive_traits(seed: &[u8]) -> Traits {
    assert!(seed.len() >= 7, "seed must be at least 7 bytes");
    Traits {
        temperament: seed[0] % N_TEMPERAMENT,
        passion: seed[1] % N_PASSION,
        speech: seed[2] % N_SPEECH,
        body: seed[3] % N_BODY,
        eyes: seed[4] % N_EYES,
        accessory: seed[5] % N_ACCESSORY,
        pattern: seed[6] % N_PATTERN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed32(first7: [u8; 7]) -> Vec<u8> {
        let mut v = vec![0u8; 32];
        v[..7].copy_from_slice(&first7);
        v
    }

    #[test]
    fn all_dials_land_inside_their_range() {
        for b in [0u8, 1, 7, 10, 99, 128, 255] {
            let t = derive_traits(&seed32([b; 7]));
            assert!(t.temperament < N_TEMPERAMENT);
            assert!(t.passion < N_PASSION);
            assert!(t.speech < N_SPEECH);
            assert!(t.body < N_BODY);
            assert!(t.eyes < N_EYES);
            assert!(t.accessory < N_ACCESSORY);
            assert!(t.pattern < N_PATTERN);
        }
    }

    #[test]
    fn same_seed_gives_same_traits() {
        let s = seed32([3, 14, 15, 92, 65, 35, 89]);
        assert_eq!(derive_traits(&s), derive_traits(&s));
    }

    #[test]
    fn each_dial_reads_its_own_byte_modulo_range() {
        // byte i drives dial i, as value % range
        let t = derive_traits(&seed32([10, 10, 10, 10, 10, 10, 10]));
        assert_eq!(t.temperament, 10 % N_TEMPERAMENT); // 2
        assert_eq!(t.passion, 10 % N_PASSION); // 2
        assert_eq!(t.speech, 10 % N_SPEECH); // 0
        assert_eq!(t.body, 10 % N_BODY); // 4
        assert_eq!(t.eyes, 10 % N_EYES); // 2
        assert_eq!(t.accessory, 10 % N_ACCESSORY); // 0
        assert_eq!(t.pattern, 10 % N_PATTERN); // 2
    }

    #[test]
    #[should_panic]
    fn too_short_seed_panics() {
        let _ = derive_traits(&[1, 2, 3]); // < 7 bytes
    }
}
