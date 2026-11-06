//! The glossy Mind, drawn on chain — the same character the game shows
//! (web/components/game/GlossyMind.tsx), so a Mind looks the same in a wallet as on the
//! site. A pure function of the keeper's look (colour, eyes, hat, outfit) and the Mind's
//! current life state; nothing is stored. The part shapes are generated into
//! `glossy_parts.rs` from the site's own code.

use crate::art::Appearance;
use crate::glossy_parts::{P, BODY, EYES, HATS, OUTFITS};

/// Indices into the glossy parts (colony.rs `Look` without the natures).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlossyLook {
    pub tone: u8,
    pub eyes: u8,
    pub hat: u8,
    pub outfit: u8,
}

/// light / base / dark body gradient per tone, in web/lib/game/look.ts TONES order:
/// pink, mint, yellow, peach, sky, lilac, coral, lime, teal, berry, cream, midnight.
const PALETTE: [[&str; 3]; 12] = [
    ["#FFD0E3", "#FF85B5", "#E2508E"],
    ["#D8FBE8", "#7FE0AE", "#3FB97C"],
    ["#FFF4C2", "#FFD25E", "#E6A92A"],
    ["#FFE2D1", "#FFA77A", "#E8774A"],
    ["#DDF0FF", "#7CC4FF", "#3A8FE0"],
    ["#EEE4FF", "#B79CFF", "#8565E0"],
    ["#FFD9D6", "#FF7A70", "#DE4E45"],
    ["#EFFBCF", "#BCE65A", "#86B52A"],
    ["#D4F6F2", "#4FD1C1", "#1F9E90"],
    ["#FBD3EC", "#D45AA8", "#A23380"],
    ["#FFF8EC", "#F2DDB8", "#CDAE7C"],
    ["#D9DDF5", "#5F6BC2", "#3A438F"],
];
/// The soft tile behind each tone (wallet image background).
const TILE: [&str; 12] = [
    "#FFE3EE", "#DDF5E6", "#FFF3CC", "#FFEADF", "#E2F2FF", "#F0E9FF", "#FFE3E0", "#F2FAD9", "#DCF7F3", "#FBE0F1", "#FFF8EC", "#E3E6F7",
];
const GHOST: [&str; 3] = ["#F4EEFA", "#D9CDEB", "#B3A3CF"];
const INK: &str = "#2A1B2C";

/// The look a Mind gets from its seven trait dials alone (no keeper choice stored) — the
/// same mapping as web/lib/game/look.ts `lookFromTraits`.
pub fn look_from_traits(t: &[u8; 7]) -> GlossyLook {
    // temperament -> pink, yellow, sky, lime, lilac, teal, mint, midnight
    const TEMPERAMENT_TONE: [u8; 8] = [0, 2, 4, 7, 5, 8, 1, 11];
    GlossyLook { tone: TEMPERAMENT_TONE[(t[0] % 8) as usize], eyes: t[4] % 8, hat: t[5] % 11, outfit: t[6] % 4 }
}

#[derive(Clone, Copy, PartialEq)]
enum Mood {
    Happy,
    Flat,
    Sad,
    Asleep,
    Ghost,
}

fn mood_of(a: Appearance) -> Mood {
    match a {
        Appearance::Full | Appearance::Content => Mood::Happy,
        Appearance::Hungry => Mood::Flat,
        Appearance::Starving => Mood::Sad,
        Appearance::Asleep => Mood::Asleep,
        Appearance::Ghost => Mood::Ghost,
    }
}

fn parts(out: &mut String, list: &[P]) {
    for z in list {
        out.push_str(&format!(
            r#"<path d="{}" fill="{}" stroke="{}" stroke-width="{}" stroke-linecap="round" stroke-linejoin="round"/>"#,
            z.d, z.fill, z.stroke, z.width
        ));
    }
}

/// The contrast colour per tone, for a hat or outfit colour that would vanish into the body
/// (the same table and distance as web/lib/game/glossyParts.ts `contrast`).
const CONTRAST: [&str; 12] = [
    "#3D5BA9", "#7A55C8", "#E2508E", "#3D5BA9", "#E2508E", "#F2A93B", "#3D5BA9", "#7A55C8", "#E2508E", "#FFD84D", "#E2508E", "#FFD84D",
];
/// A part whose main colour is closer than this to the body would vanish: it is recoloured,
/// with every shade of it closer than SHADE (glossyParts.ts CLASH_DISTANCE / SHADE_DISTANCE).
const CLASH_DISTANCE_SQ: i32 = 50 * 50;
const SHADE_DISTANCE_SQ: i32 = 75 * 75;

fn rgb(h: &str) -> Option<[i32; 3]> {
    let b = h.as_bytes();
    if b.len() != 7 || b[0] != b'#' {
        return None;
    }
    let c = |i: usize| i32::from_str_radix(&h[i..i + 2], 16).ok();
    Some([c(1)?, c(3)?, c(5)?])
}
fn dist_sq(a: [i32; 3], b: [i32; 3]) -> i32 {
    (a[0] - b[0]).pow(2) + (a[1] - b[1]).pow(2) + (a[2] - b[2]).pow(2)
}

/// How close a colour is to the body (squared distance to its base or dark), if it is a colour.
fn to_body(tone: usize, colour: &str) -> Option<i32> {
    let (c, base, dark) = (rgb(colour)?, rgb(PALETTE[tone][1])?, rgb(PALETTE[tone][2])?);
    Some(dist_sq(c, base).min(dist_sq(c, dark)))
}

/// `colour` in a clashing part: the tone's contrast colour for every shade close to the body.
fn contrast(tone: usize, colour: &'static str) -> &'static str {
    match to_body(tone, colour) {
        Some(d) if d < SHADE_DISTANCE_SQ => CONTRAST[tone],
        _ => colour,
    }
}

/// Does this part's main colour (its first coloured shape) vanish into the tone?
fn clashes(list: &[P], tone: usize) -> bool {
    list.iter()
        .map(|z| if rgb(z.fill).is_some() { z.fill } else { z.stroke })
        .find(|c| rgb(c).is_some())
        .and_then(|c| to_body(tone, c))
        .is_some_and(|d| d < CLASH_DISTANCE_SQ)
}

/// A hat's or outfit's shapes, recoloured when they would vanish into this tone.
fn parts_on(out: &mut String, list: &[P], tone: Option<usize>) {
    let Some(t) = tone.filter(|&t| clashes(list, t)) else { return parts(out, list) };
    for z in list {
        out.push_str(&format!(
            r#"<path d="{}" fill="{}" stroke="{}" stroke-width="{}" stroke-linecap="round" stroke-linejoin="round"/>"#,
            z.d,
            contrast(t, z.fill),
            contrast(t, z.stroke),
            z.width
        ));
    }
}

/// The full SVG. `frame` adds the tone's soft tile behind the creature (for wallets);
/// without it the background is transparent. `uid` (the token id) makes the gradient ids
/// unique, so several Minds inlined in one page don't borrow each other's colours.
pub fn render(look: &GlossyLook, appearance: Appearance, frame: bool, uid: u64) -> String {
    let mood = mood_of(appearance);
    let tone = (look.tone as usize).min(PALETTE.len() - 1);
    let [c1, c2, c3] = if mood == Mood::Ghost { GHOST } else { PALETTE[tone] };
    let awake = matches!(mood, Mood::Happy | Mood::Flat | Mood::Sad);
    let eyes = (look.eyes as usize).min(10);
    let hat = (look.hat as usize).min(10);
    let outfit = (look.outfit as usize).min(10);

    let mut s = String::with_capacity(6000);
    s.push_str(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -30 240 250">"#);
    s.push_str(&format!(
        r##"<defs><clipPath id="c{uid}"><path d="{BODY}"/></clipPath><radialGradient id="b{uid}" cx="38%" cy="30%" r="75%"><stop offset="0%" stop-color="{c1}"/><stop offset="55%" stop-color="{c2}"/><stop offset="100%" stop-color="{c3}"/></radialGradient><radialGradient id="f{uid}" cx="40%" cy="30%" r="80%"><stop offset="0%" stop-color="{c2}"/><stop offset="100%" stop-color="{c3}"/></radialGradient><radialGradient id="s{uid}" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#3A2A1A" stop-opacity=".28"/><stop offset="100%" stop-color="#3A2A1A" stop-opacity="0"/></radialGradient><radialGradient id="a{uid}" cx="35%" cy="30%" r="70%"><stop offset="0%" stop-color="#FFE3EE"/><stop offset="100%" stop-color="{c2}"/></radialGradient></defs>"##
    ));
    if frame {
        let bg = if mood == Mood::Ghost { "#EFE8F6" } else { TILE[tone] };
        s.push_str(&format!(r#"<rect x="-20" y="-30" width="240" height="250" fill="{bg}"/>"#));
    }
    s.push_str(&format!(r#"<ellipse cx="100" cy="198" rx="62" ry="10" fill="url(#s{uid})"/>"#));
    s.push_str(&format!(r#"<g opacity="{}">"#, if mood == Mood::Ghost { "0.7" } else { "1" }));
    if hat == 0 {
        s.push_str(&format!(r##"<path d="M100 40 C 98 26, 104 16, 114 14" fill="none" stroke="#3A2436" stroke-width="3.5" stroke-linecap="round"/><circle cx="116" cy="13" r="7" fill="url(#a{uid})" stroke="#3A2436" stroke-width="2.5"/><circle cx="114" cy="11" r="2" fill="#FFFFFF" opacity=".9"/>"##));
    }
    s.push_str(&format!(r##"<ellipse cx="30" cy="132" rx="15" ry="11" fill="url(#f{uid})" transform="rotate(-30 30 132)"/><ellipse cx="172" cy="130" rx="15" ry="11" fill="url(#f{uid})" transform="rotate(30 172 130)"/><ellipse cx="72" cy="186" rx="20" ry="12" fill="url(#f{uid})"/><ellipse cx="128" cy="186" rx="20" ry="12" fill="url(#f{uid})"/><path d="M100 38 C 148 38, 174 76, 174 120 C 174 162, 144 186, 100 186 C 56 186, 26 162, 26 120 C 26 76, 52 38, 100 38 Z" fill="url(#b{uid})"/><ellipse cx="68" cy="70" rx="24" ry="13" fill="#FFFFFF" opacity=".55" transform="rotate(-28 68 70)"/><ellipse cx="56" cy="92" rx="5" ry="4" fill="#FFFFFF" opacity=".5"/><path d="M150 70 l3 -8 l3 8 l8 3 l-8 3 l-3 8 l-3 -8 l-8 -3 z" fill="#FFFFFF" opacity=".75"/><path d="M40 150 C 60 176, 140 176, 160 150" fill="none" stroke="#FFFFFF" stroke-opacity=".18" stroke-width="6" stroke-linecap="round"/></g>"##));
    // Outfits are cut to the body outline, so a garment never sticks out past the silhouette.
    s.push_str(&format!(r#"<g clip-path="url(#c{uid})">"#));
    let on_tone = if mood == Mood::Ghost { None } else { Some(tone) };
    parts_on(&mut s, OUTFITS[outfit], on_tone);
    s.push_str("</g>");
    if awake && eyes == 0 {
        s.push_str(&format!(
            r##"<ellipse cx="76" cy="112" rx="13" ry="14" fill="{INK}"/><ellipse cx="124" cy="112" rx="13" ry="14" fill="{INK}"/><circle cx="80" cy="106" r="5" fill="#FFFFFF"/><circle cx="128" cy="106" r="5" fill="#FFFFFF"/><circle cx="72" cy="117" r="2" fill="#FFFFFF" opacity=".7"/><circle cx="120" cy="117" r="2" fill="#FFFFFF" opacity=".7"/>"##
        ));
    }
    if mood == Mood::Asleep {
        s.push_str(&format!(r#"<g fill="none" stroke="{INK}" stroke-width="4" stroke-linecap="round"><path d="M64 112 Q 76 121 88 112"/><path d="M112 112 Q 124 121 136 112"/></g>"#));
    }
    if mood == Mood::Ghost {
        s.push_str(r##"<ellipse cx="76" cy="112" rx="11" ry="12" fill="none" stroke="#8E7FA8" stroke-width="3" stroke-dasharray="4 4"/><ellipse cx="124" cy="112" rx="11" ry="12" fill="none" stroke="#8E7FA8" stroke-width="3" stroke-dasharray="4 4"/>"##);
    }
    if matches!(mood, Mood::Happy | Mood::Asleep) {
        s.push_str(r##"<ellipse cx="58" cy="134" rx="12" ry="7" fill="#FF5C93" opacity=".45"/><ellipse cx="142" cy="134" rx="12" ry="7" fill="#FF5C93" opacity=".45"/>"##);
    }
    let mouth = match mood {
        Mood::Happy => Some("M88 136 Q 100 148 112 136"),
        Mood::Flat | Mood::Asleep => Some("M90 140 L 110 140"),
        Mood::Sad => Some("M88 144 Q 100 134 112 144"),
        Mood::Ghost => None,
    };
    if let Some(d) = mouth {
        s.push_str(&format!(r#"<path d="{d}" fill="none" stroke="{INK}" stroke-width="4" stroke-linecap="round"/>"#));
    }
    if awake {
        parts(&mut s, EYES[eyes]);
    }
    parts_on(&mut s, HATS[hat], on_tone);
    s.push_str("</svg>");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOOK: GlossyLook = GlossyLook { tone: 4, eyes: 2, hat: 3, outfit: 1 };

    #[test]
    fn it_is_a_standalone_svg_in_the_chosen_colour() {
        let s = render(&LOOK, Appearance::Full, true, 7);
        assert!(s.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(s.ends_with("</svg>"));
        assert!(s.contains("#7CC4FF"), "sky body colour");
        assert!(s.contains("#E2F2FF"), "sky tile behind it");
        assert!(s.contains("M88 136 Q 100 148 112 136"), "a full Mind smiles");
    }

    #[test]
    fn gradient_ids_are_unique_per_token() {
        let a = render(&LOOK, Appearance::Full, true, 1);
        let b = render(&LOOK, Appearance::Full, true, 2);
        assert!(a.contains(r#"id="b1""#) && a.contains("url(#b1)") && !a.contains("url(#b)"));
        assert!(b.contains(r#"id="b2""#));
    }

    #[test]
    fn the_bare_variant_has_no_background() {
        assert!(!render(&LOOK, Appearance::Full, false, 7).contains("<rect"));
    }

    #[test]
    fn hunger_and_sleep_change_the_face() {
        assert!(render(&LOOK, Appearance::Hungry, true, 7).contains("M90 140 L 110 140"));
        assert!(render(&LOOK, Appearance::Starving, true, 7).contains("M88 144 Q 100 134 112 144"));
        let asleep = render(&LOOK, Appearance::Asleep, true, 7);
        assert!(asleep.contains("M64 112 Q 76 121 88 112"), "closed eyes");
        assert!(!asleep.contains("M76 124 C58 112"), "no heart eyes while asleep");
        assert!(render(&LOOK, Appearance::Full, true, 7).contains("M76 124 C58 112"), "heart eyes when awake");
    }

    #[test]
    fn a_ghost_loses_its_colour() {
        let g = render(&LOOK, Appearance::Ghost, true, 7);
        assert!(g.contains("#D9CDEB") && !g.contains("#7CC4FF"));
        assert!(g.contains("stroke-dasharray=\"4 4\""));
    }

    #[test]
    fn a_hat_replaces_the_antenna() {
        assert!(!render(&LOOK, Appearance::Full, true, 7).contains("M100 40 C 98 26"));
        assert!(render(&GlossyLook { hat: 0, ..LOOK }, Appearance::Full, true, 7).contains("M100 40 C 98 26"));
    }

    #[test]
    fn traits_alone_give_a_valid_look() {
        let l = look_from_traits(&[3, 0, 0, 0, 9, 12, 7]);
        assert_eq!(l, GlossyLook { tone: 7, eyes: 1, hat: 1, outfit: 3 });
        assert!(render(&l, Appearance::Content, true, 7).contains("#BCE65A"));
    }

    // --- clothes never vanish into the body colour ---
    #[test]
    fn a_pink_scarf_on_a_pink_mind_is_drawn_in_navy() {
        assert_eq!(contrast(0, "#FF6FA3"), "#3D5BA9"); // scarf on pink
        assert_eq!(contrast(0, "#E2508E"), "#3D5BA9"); // bandana = pink's own dark
        let svg = render(&GlossyLook { tone: 0, eyes: 0, hat: 0, outfit: 1 }, Appearance::Full, true, 1);
        assert!(svg.contains("#3D5BA9") && !svg.contains(r##"fill="#FF6FA3""##));
    }

    #[test]
    fn clothes_far_from_the_body_colour_keep_their_own() {
        assert_eq!(contrast(5, "#FF6FA3"), "#FF6FA3"); // pink scarf on lilac stays pink
        assert_eq!(contrast(0, "#3F6AD8"), "#3F6AD8"); // blue overalls on pink stay blue
        assert_eq!(contrast(0, "#FFFFFF"), "#FFFFFF");
        assert_eq!(contrast(0, "none"), "none");
    }

    #[test]
    fn same_colour_clothes_are_recoloured_on_each_tone() {
        assert_eq!(contrast(2, "#FFD84D"), "#E2508E"); // yellow sweater on yellow
        assert_eq!(contrast(5, "#A78BFA"), "#F2A93B"); // lilac hoodie on lilac
        assert_eq!(contrast(4, "#3F6AD8"), "#E2508E"); // blue overalls on sky
        assert_eq!(contrast(11, "#3F6AD8"), "#FFD84D"); // blue overalls on midnight
    }

    #[test]
    fn a_ghost_keeps_its_clothes_as_they_are() {
        let svg = render(&GlossyLook { tone: 0, eyes: 0, hat: 0, outfit: 1 }, Appearance::Ghost, true, 1);
        assert!(svg.contains("#FF6FA3"));
    }
}
