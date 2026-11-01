//! On-chain art. A Mind's appearance is assembled here from its visual traits and
//! its current life-state — no image is stored, the SVG is a pure function of state,
//! so `svg_for` always renders the *current* creature (full, hungry, asleep, ghost).
//! Design concept (build plan §17): a small window into a living creature. Temperament
//! is the room's weather (the palette); hunger is written on the face; body, eyes,
//! accessory and pattern make each one itself. (Passion and speech are behavioural
//! dials — they shape the AI voice, not the picture.)
//!
//! Pure + deterministic: unit-tested without near-sdk.

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

/// Everything the renderer needs: the 7 trait dials and the current state. The name
/// is deliberately NOT here — no owner-chosen text reaches the SVG, so the markup is a
/// closed template of fixed palette hex + numeric coords and needs no XML escaping.
pub struct Face {
    /// [temperament, passion, speech, body, eyes, accessory, pattern]
    pub traits: [u8; 7],
    pub appearance: Appearance,
}

/// One temperament's palette: the room's weather + the creature's own colours.
struct Palette {
    bg0: &'static str,
    bg1: &'static str,
    body: &'static str,
    ink: &'static str,
    accent: &'static str,
}

/// Eight temperaments, eight moods. Each is a deliberate small scheme — a dark,
/// calm backdrop so the creature reads at wallet-thumbnail size, a soft body, a
/// dark ink for the face, and one accent for adornments.
const PALETTES: [Palette; 8] = [
    // 0 shy — rose dusk
    Palette { bg0: "#3a2b3f", bg1: "#231a2b", body: "#f4c6d2", ink: "#5b3a4e", accent: "#ef9bb4" },
    // 1 bold — ember
    Palette { bg0: "#4a1f16", bg1: "#2a110c", body: "#ff8a5c", ink: "#3a150c", accent: "#ffd166" },
    // 2 philosopher — indigo night
    Palette { bg0: "#1c2749", bg1: "#0e1530", body: "#9fb0e6", ink: "#1a2240", accent: "#c8d3ff" },
    // 3 grouch — mossy slate
    Palette { bg0: "#2b332b", bg1: "#171c17", body: "#9db58a", ink: "#273024", accent: "#d6e07a" },
    // 4 dreamer — twilight teal
    Palette { bg0: "#14323f", bg1: "#1b1f3a", body: "#8fe3d8", ink: "#123038", accent: "#b59cff" },
    // 5 pedant — graphite paper
    Palette { bg0: "#2a2e33", bg1: "#16181c", body: "#d7dde3", ink: "#2b3036", accent: "#7fb0c9" },
    // 6 joker — plum & lime
    Palette { bg0: "#35184a", bg1: "#1d0d2a", body: "#f6a6ff", ink: "#3a1250", accent: "#c3f04a" },
    // 7 melancholic — rainy blue
    Palette { bg0: "#26323f", bg1: "#141b22", body: "#a9c0d6", ink: "#223040", accent: "#7f9bb5" },
];

/// Whole-creature opacity falls as it goes hungry, so a thumbnail reads its mood
/// before you read the face.
fn state_opacity(a: Appearance) -> &'static str {
    match a {
        Appearance::Full => "1",
        Appearance::Content => "0.97",
        Appearance::Hungry => "0.9",
        Appearance::Starving => "0.74",
        Appearance::Asleep => "0.62",
        Appearance::Ghost => "0.4",
    }
}

/// The body silhouette (6 variants), centred at (60, 66).
fn body_shape(v: usize, body: &str, ink: &str) -> String {
    let fill = format!("fill=\"{}\" stroke=\"{}\" stroke-width=\"2\"", body, ink);
    match v % 6 {
        0 => format!("<ellipse cx=\"60\" cy=\"66\" rx=\"31\" ry=\"30\" {}/>", fill), // round
        1 => format!("<ellipse cx=\"60\" cy=\"66\" rx=\"25\" ry=\"34\" {}/>", fill), // tall
        2 => format!("<ellipse cx=\"60\" cy=\"68\" rx=\"35\" ry=\"25\" {}/>", fill), // squat
        3 => format!("<rect x=\"30\" y=\"38\" width=\"60\" height=\"56\" rx=\"26\" {}/>", fill), // bean
        4 => format!("<rect x=\"32\" y=\"40\" width=\"56\" height=\"54\" rx=\"12\" {}/>", fill), // blocky
        _ => format!(
            // teardrop — a rounded body pinched to a point on top
            "<path d=\"M60 34 C78 40 90 54 90 70 C90 88 76 96 60 96 C44 96 30 88 30 70 C30 54 42 40 60 34 Z\" {}/>",
            fill
        ),
    }
}

/// Low-contrast markings on the body (4 variants). Drawn in ink at low opacity so
/// they sit *on* the body without competing with the face.
fn pattern_overlay(v: usize, ink: &str) -> String {
    match v % 4 {
        0 => String::new(), // plain
        1 => format!(
            // spots
            "<g fill=\"{}\" opacity=\"0.18\"><circle cx=\"44\" cy=\"80\" r=\"4\"/><circle cx=\"74\" cy=\"84\" r=\"5\"/><circle cx=\"60\" cy=\"88\" r=\"3\"/></g>",
            ink
        ),
        2 => format!(
            // stripes
            "<g stroke=\"{}\" stroke-width=\"2.5\" opacity=\"0.15\" fill=\"none\"><path d=\"M38 78 H82\"/><path d=\"M40 86 H80\"/></g>",
            ink
        ),
        _ => format!(
            // freckles
            "<g fill=\"{}\" opacity=\"0.2\"><circle cx=\"47\" cy=\"68\" r=\"1.6\"/><circle cx=\"73\" cy=\"68\" r=\"1.6\"/><circle cx=\"50\" cy=\"72\" r=\"1.3\"/><circle cx=\"70\" cy=\"72\" r=\"1.3\"/></g>",
            ink
        ),
    }
}

/// Eyes (8 open variants) at (50,60) and (70,60). Sleep closes them; a ghost's go
/// hollow. These overrides matter more than the dial — state is read first.
fn eyes_shape(v: usize, a: Appearance, ink: &str) -> String {
    if a == Appearance::Asleep {
        // closed, content arcs
        return format!(
            "<g stroke=\"{}\" stroke-width=\"2\" fill=\"none\" stroke-linecap=\"round\"><path d=\"M45 60 Q50 64 55 60\"/><path d=\"M65 60 Q70 64 75 60\"/></g>",
            ink
        );
    }
    if a == Appearance::Ghost {
        // hollow, far-away eyes
        return format!(
            "<g stroke=\"{}\" stroke-width=\"1.6\" fill=\"none\"><circle cx=\"50\" cy=\"60\" r=\"4\"/><circle cx=\"70\" cy=\"60\" r=\"4\"/></g>",
            ink
        );
    }
    // Starving droops the eyes a little; otherwise the open variant shows.
    let droop = a == Appearance::Starving;
    let (lx, rx, ey) = (50.0, 70.0, if droop { 62.0 } else { 60.0 });
    match v % 8 {
        0 => format!(
            "<g fill=\"{ink}\"><circle cx=\"{lx}\" cy=\"{ey}\" r=\"3.5\"/><circle cx=\"{rx}\" cy=\"{ey}\" r=\"3.5\"/></g>"
        ), // dots
        1 => format!(
            "<g fill=\"{ink}\"><ellipse cx=\"{lx}\" cy=\"{ey}\" rx=\"3\" ry=\"4.5\"/><ellipse cx=\"{rx}\" cy=\"{ey}\" rx=\"3\" ry=\"4.5\"/></g>"
        ), // oval
        2 => format!(
            "<g fill=\"{ink}\"><circle cx=\"{lx}\" cy=\"{ey}\" r=\"5\"/><circle cx=\"{rx}\" cy=\"{ey}\" r=\"5\"/></g><g fill=\"#fff\"><circle cx=\"{lxh}\" cy=\"{eyh}\" r=\"1.6\"/><circle cx=\"{rxh}\" cy=\"{eyh}\" r=\"1.6\"/></g>",
            lxh = lx + 1.6, rxh = rx + 1.6, eyh = ey - 1.6
        ), // wide with glint
        3 => format!(
            "<g stroke=\"{ink}\" stroke-width=\"2\" fill=\"none\" stroke-linecap=\"round\"><path d=\"M{l0} {ey} Q{lx} {eyd} {l1} {ey}\"/><path d=\"M{r0} {ey} Q{rx} {eyd} {r1} {ey}\"/></g>",
            l0 = lx - 4.0, l1 = lx + 4.0, r0 = rx - 4.0, r1 = rx + 4.0, eyd = ey + 4.0
        ), // sleepy half-lids
        4 => format!(
            "<g fill=\"{ink}\" stroke=\"{ink}\"><circle cx=\"{lx}\" cy=\"{ey}\" r=\"4\" fill=\"none\" stroke-width=\"1.6\"/><circle cx=\"{lx}\" cy=\"{ey}\" r=\"1.8\"/><circle cx=\"{rx}\" cy=\"{ey}\" r=\"4\" fill=\"none\" stroke-width=\"1.6\"/><circle cx=\"{rx}\" cy=\"{ey}\" r=\"1.8\"/></g>"
        ), // ringed
        5 => format!(
            "<g fill=\"{ink}\"><circle cx=\"{lx}\" cy=\"{ey}\" r=\"2.4\"/><circle cx=\"{rx}\" cy=\"{ey}\" r=\"2.4\"/></g>"
        ), // small
        6 => format!(
            "<g fill=\"{ink}\"><ellipse cx=\"{lx}\" cy=\"{ey}\" rx=\"4.5\" ry=\"3\"/><ellipse cx=\"{rx}\" cy=\"{ey}\" rx=\"4.5\" ry=\"3\"/></g>"
        ), // wide-set lozenge
        _ => format!(
            "<g fill=\"{ink}\"><circle cx=\"{lx}\" cy=\"{ey}\" r=\"3.5\"/><path d=\"M{r0} {ey} Q{rx} {eyd} {r1} {ey}\" stroke=\"{ink}\" stroke-width=\"2\" fill=\"none\" stroke-linecap=\"round\"/></g>",
            r0 = rx - 4.0, r1 = rx + 4.0, eyd = ey + 4.0
        ), // wink
    }
}

/// The mouth is the clock face of hunger — it is derived entirely from state.
fn mouth_shape(a: Appearance, ink: &str, accent: &str) -> String {
    match a {
        Appearance::Full => format!(
            "<path d=\"M50 74 Q60 86 70 74\" stroke=\"{ink}\" stroke-width=\"2.4\" fill=\"{accent}\" fill-opacity=\"0.5\" stroke-linecap=\"round\"/>"
        ),
        Appearance::Content => format!(
            "<path d=\"M52 76 Q60 82 68 76\" stroke=\"{ink}\" stroke-width=\"2.4\" fill=\"none\" stroke-linecap=\"round\"/>"
        ),
        Appearance::Hungry => format!(
            "<path d=\"M53 78 H67\" stroke=\"{ink}\" stroke-width=\"2.4\" fill=\"none\" stroke-linecap=\"round\"/>"
        ),
        Appearance::Starving => format!(
            "<path d=\"M53 80 Q60 74 67 80\" stroke=\"{ink}\" stroke-width=\"2.4\" fill=\"none\" stroke-linecap=\"round\"/>"
        ),
        Appearance::Asleep => format!(
            "<path d=\"M55 78 Q60 80 65 78\" stroke=\"{ink}\" stroke-width=\"2\" fill=\"none\" stroke-linecap=\"round\"/>"
        ),
        Appearance::Ghost => format!(
            "<ellipse cx=\"60\" cy=\"78\" rx=\"3\" ry=\"4\" fill=\"{ink}\" opacity=\"0.8\"/>"
        ),
    }
}

/// A head adornment (10 variants) in the accent colour. Several are intentionally
/// minimal — not every creature wears something loud.
fn accessory_shape(v: usize, accent: &str, ink: &str) -> String {
    match v % 10 {
        0 => String::new(), // bare
        1 => format!(
            "<g stroke=\"{accent}\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M60 36 V28\"/></g><circle cx=\"60\" cy=\"26\" r=\"3\" fill=\"{accent}\"/>"
        ), // antenna
        2 => format!(
            "<path d=\"M44 40 L60 28 L76 40 Z\" fill=\"{accent}\" stroke=\"{ink}\" stroke-width=\"1.4\"/>"
        ), // cap
        3 => format!(
            "<g fill=\"{accent}\" stroke=\"{ink}\" stroke-width=\"1.2\"><path d=\"M54 34 L60 38 L54 42 Z\"/><path d=\"M66 34 L60 38 L66 42 Z\"/></g>"
        ), // bow
        4 => format!(
            "<ellipse cx=\"60\" cy=\"30\" rx=\"12\" ry=\"3.5\" fill=\"none\" stroke=\"{accent}\" stroke-width=\"2.2\"/>"
        ), // halo
        5 => format!(
            "<path d=\"M44 90 Q60 98 76 90\" stroke=\"{accent}\" stroke-width=\"4\" fill=\"none\" stroke-linecap=\"round\"/>"
        ), // scarf
        6 => format!(
            "<g fill=\"none\" stroke=\"{ink}\" stroke-width=\"1.6\"><circle cx=\"50\" cy=\"60\" r=\"6\"/><circle cx=\"70\" cy=\"60\" r=\"6\"/><path d=\"M56 60 H64\"/></g>"
        ), // glasses
        7 => format!(
            "<g fill=\"{accent}\" opacity=\"0.75\"><circle cx=\"44\" cy=\"68\" r=\"2.2\"/><circle cx=\"76\" cy=\"68\" r=\"2.2\"/></g>"
        ), // blush cheeks
        8 => format!(
            "<path d=\"M46 92 Q60 86 74 92\" stroke=\"{accent}\" stroke-width=\"3\" fill=\"none\"/>"
        ), // collar
        _ => format!(
            "<path d=\"M48 36 L52 30 L56 36 L60 29 L64 36 L68 30 L72 36 Z\" fill=\"{accent}\" stroke=\"{ink}\" stroke-width=\"1\"/>"
        ), // crown
    }
}

/// Assemble the full SVG document for a Mind. Self-contained (its own background),
/// deterministic, and small enough to return inline (well under the 4 MiB view cap).
/// This is the canonical on-chain art (framed window), used by `svg_for`/`nft_token`.
pub fn render(face: &Face) -> String {
    render_inner(face, true)
}

/// Background-less variant (transparent, no frame or floor shadow): just the creature,
/// for the web habitat where it floats in a light beam. Not used on-chain.
pub fn render_bare(face: &Face) -> String {
    render_inner(face, false)
}

fn render_inner(face: &Face, frame: bool) -> String {
    let t = face.traits;
    let a = face.appearance;
    let pal = &PALETTES[(t[0] as usize) % PALETTES.len()];
    let gid = (t[0] as usize) % PALETTES.len(); // unique gradient id per palette

    let body = body_shape(t[3] as usize, pal.body, pal.ink);
    let pattern = pattern_overlay(t[6] as usize, pal.ink);
    let eyes = eyes_shape(t[4] as usize, a, pal.ink);
    let mouth = mouth_shape(a, pal.ink, pal.accent);
    // A ghost drops its earthly adornments; everyone else wears theirs.
    let accessory = if a == Appearance::Ghost {
        String::new()
    } else {
        accessory_shape(t[5] as usize, pal.accent, pal.ink)
    };
    // Floor shadow grounds a living creature (framed art only; the habitat provides
    // its own platform glow). A ghost floats and casts none.
    let shadow = if frame && a != Appearance::Ghost {
        "<ellipse cx=\"60\" cy=\"104\" rx=\"24\" ry=\"4\" fill=\"#000\" opacity=\"0.18\"/>".to_string()
    } else {
        String::new()
    };

    // Sleep z's drift up from the head.
    let zzz = if a == Appearance::Asleep {
        format!(
            "<g fill=\"none\" stroke=\"{}\" stroke-width=\"1.6\" stroke-linecap=\"round\" opacity=\"0.8\"><path d=\"M84 40 h5 l-5 6 h5\"/><path d=\"M92 30 h4 l-4 5 h4\"/><path d=\"M98 22 h3 l-3 4 h3\"/></g>",
            pal.accent
        )
    } else {
        String::new()
    };

    // A ghost gets a dashed, wavering outline over its faded body.
    let ghost_outline = if a == Appearance::Ghost {
        format!(
            "<ellipse cx=\"60\" cy=\"66\" rx=\"33\" ry=\"32\" fill=\"none\" stroke=\"{}\" stroke-width=\"1.4\" stroke-dasharray=\"3 4\" opacity=\"0.7\"/>",
            pal.accent
        )
    } else {
        String::new()
    };

    let dy = if a == Appearance::Ghost { -4 } else { 0 };
    let opacity = state_opacity(a);

    // The framed art carries its own gradient background + border window; the bare
    // variant is transparent so the creature floats in the web habitat.
    let frame_markup = if frame {
        format!(
            "<defs><linearGradient id=\"bg{gid}\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\
<stop offset=\"0\" stop-color=\"{bg0}\"/><stop offset=\"1\" stop-color=\"{bg1}\"/></linearGradient></defs>\
<rect width=\"120\" height=\"120\" rx=\"16\" fill=\"url(#bg{gid})\"/>\
<rect x=\"3\" y=\"3\" width=\"114\" height=\"114\" rx=\"14\" fill=\"none\" stroke=\"{accent}\" stroke-width=\"1\" opacity=\"0.25\"/>",
            bg0 = pal.bg0,
            bg1 = pal.bg1,
            accent = pal.accent,
        )
    } else {
        String::new()
    };

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 120\" width=\"120\" height=\"120\">\
{frame_markup}{shadow}\
<g opacity=\"{opacity}\" transform=\"translate(0 {dy})\">\
{body}{pattern}{ghost_outline}{eyes}{mouth}{accessory}\
</g>{zzz}</svg>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn face(traits: [u8; 7], appearance: Appearance) -> String {
        render(&Face { traits, appearance })
    }

    #[test]
    fn is_a_wellformed_svg_envelope() {
        let s = face([0; 7], Appearance::Full);
        assert!(s.trim_start().starts_with("<svg"), "must open with <svg");
        assert!(s.trim_end().ends_with("</svg>"), "must close the svg");
        assert!(s.contains("viewBox"), "needs a viewBox to scale in wallets");
    }

    #[test]
    fn is_deterministic() {
        assert_eq!(face([3, 1, 4, 1, 5, 9, 2], Appearance::Hungry),
                   face([3, 1, 4, 1, 5, 9, 2], Appearance::Hungry));
    }

    #[test]
    fn temperament_changes_the_palette() {
        // Only the temperament dial differs -> the art must differ (colour = temperament).
        let a = face([0, 2, 2, 2, 2, 2, 2], Appearance::Full);
        let b = face([5, 2, 2, 2, 2, 2, 2], Appearance::Full);
        assert_ne!(a, b);
    }

    #[test]
    fn every_life_state_renders_a_distinct_face() {
        use Appearance::*;
        let base = [2u8, 3, 1, 2, 4, 5, 1];
        let states = [Full, Content, Hungry, Starving, Asleep, Ghost];
        for i in 0..states.len() {
            for j in (i + 1)..states.len() {
                assert_ne!(
                    face(base, states[i]),
                    face(base, states[j]),
                    "{:?} and {:?} must look different",
                    states[i],
                    states[j]
                );
            }
        }
    }

    #[test]
    fn out_of_range_trait_bytes_never_panic() {
        // Defensive: render must clamp/modulo, never index out of bounds.
        let _ = face([255; 7], Appearance::Ghost);
        let _ = face([200, 199, 198, 197, 196, 195, 194], Appearance::Full);
    }

    #[test]
    fn stays_small_enough_to_return_inline() {
        let s = face([7, 7, 7, 7, 7, 7, 7], Appearance::Full);
        assert!(s.len() < 8192, "on-chain SVG should stay compact, was {}", s.len());
    }

    #[test]
    fn bare_render_drops_the_background_frame() {
        let f = Face { traits: [1; 7], appearance: Appearance::Full };
        let framed = render(&f);
        let bare = render_bare(&f);
        assert!(framed.contains("linearGradient"), "framed art has its own background");
        assert!(!bare.contains("linearGradient"), "bare art is transparent, no background");
        assert!(bare.trim_start().starts_with("<svg") && bare.trim_end().ends_with("</svg>"));
        assert!(bare.contains("<ellipse") || bare.contains("<path") || bare.contains("<circle"));
    }

    /// Not a test — a design harness. Writes a visual contact sheet so the art can
    /// be eyeballed and critiqued. Run: `cargo test gallery -- --ignored --nocapture`
    /// with GALLERY_OUT set to the output path.
    #[test]
    #[ignore]
    fn gallery() {
        use Appearance::*;
        let mut cells = String::new();
        let mut cell = |label: String, svg: String| {
            cells.push_str(&format!(
                "<figure><div class=\"art\">{svg}</div><figcaption>{label}</figcaption></figure>"
            ));
        };

        // The life arc of one creature.
        let arc = [2u8, 0, 1, 0, 2, 1, 0];
        for (st, name) in [
            (Full, "Full"), (Content, "Content"), (Hungry, "Hungry"),
            (Starving, "Starving"), (Asleep, "Asleep"), (Ghost, "Ghost"),
        ] {
            cell(format!("arc · {name}"), render(&Face { traits: arc, appearance: st }));
        }

        // All eight temperaments, Full, so the palettes sit side by side.
        let temps = ["shy", "bold", "philosopher", "grouch", "dreamer", "pedant", "joker", "melancholic"];
        for (i, tn) in temps.iter().enumerate() {
            cell(format!("temp · {tn}"), render(&Face {
                traits: [i as u8, i as u8, 0, (i % 6) as u8, (i % 8) as u8, (i % 10) as u8, (i % 4) as u8],
                appearance: Full,
            }));
        }

        // Trait variety: vary body/eyes/accessory/passion to sanity-check uniqueness.
        for i in 0..8u8 {
            cell(format!("var · {i}"), render(&Face {
                traits: [(i * 3) % 8, (i * 5) % 8, i % 5, i % 6, i % 8, (i * 7) % 10, i % 4],
                appearance: Full,
            }));
        }

        let html = format!(
            "<!doctype html><meta charset=utf-8><title>Hungry Minds art</title>\
<style>body{{margin:0;background:#0d0f13;color:#aeb6c2;font:13px/1.4 -apple-system,Segoe UI,sans-serif;padding:28px}}\
h1{{font-weight:600;color:#e7ecf3;font-size:18px;margin:0 0 20px}}\
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:18px}}\
figure{{margin:0;text-align:center}}\
.art{{background:#15181e;border-radius:14px;padding:12px;display:flex;justify-content:center}}\
.art svg{{width:128px;height:128px}}\
figcaption{{margin-top:8px;font-size:11px;color:#79828f}}</style>\
<h1>Hungry Minds — on-chain art contact sheet</h1><div class=grid>{cells}</div>"
        );

        let out = std::env::var("GALLERY_OUT").unwrap_or_else(|_| "gallery.html".to_string());
        std::fs::write(&out, html).expect("write gallery");
        println!("gallery written to {out}");
    }

    /// Exports the REAL contract art as JSON for the web app's preview mode, so the
    /// site shows exactly what the chain renders. Run with SAMPLES_OUT set.
    #[test]
    #[ignore]
    fn export_samples() {
        use Appearance::*;
        fn esc(s: &str) -> String {
            s.replace('\\', "\\\\").replace('"', "\\\"")
        }
        fn svg(traits: [u8; 7], a: Appearance) -> String {
            esc(&render(&Face { traits, appearance: a }))
        }
        fn svg_bare(traits: [u8; 7], a: Appearance) -> String {
            esc(&render_bare(&Face { traits, appearance: a }))
        }

        // Hero: one creature across its whole life, keyed by state.
        let hero = [4u8, 3, 1, 0, 2, 4, 1]; // dreamer, teal, halo
        let states = [
            ("full", Full), ("content", Content), ("hungry", Hungry),
            ("starving", Starving), ("asleep", Asleep), ("ghost", Ghost),
        ];
        let pal_of = |tr: [u8; 7]| &PALETTES[(tr[0] as usize) % PALETTES.len()];
        let mut hero_json = String::from("{");
        let mut hero_bare_json = String::from("{");
        for (i, (label, st)) in states.iter().enumerate() {
            if i > 0 {
                hero_json.push(',');
                hero_bare_json.push(',');
            }
            hero_json.push_str(&format!("\"{label}\":\"{}\"", svg(hero, *st)));
            hero_bare_json.push_str(&format!("\"{label}\":\"{}\"", svg_bare(hero, *st)));
        }
        hero_json.push('}');
        hero_bare_json.push('}');
        let hero_pal = pal_of(hero);

        // Gallery: varied creatures across the arc, with believable demo vitals.
        let gallery = [
            (0u64, "Juno", [4u8, 3, 1, 0, 2, 4, 1], Full, "0.82", 41u64),
            (1, "Rue", [0, 2, 2, 5, 1, 3, 0], Content, "0.31", 118),
            (2, "Pip", [6, 5, 0, 1, 6, 6, 2], Full, "0.67", 9),
            (3, "Moss", [3, 6, 3, 4, 4, 9, 3], Hungry, "0.041", 233),
            (4, "Echo", [2, 0, 1, 3, 5, 1, 1], Full, "0.90", 27),
            (5, "Sol", [1, 1, 4, 2, 2, 2, 0], Starving, "0.008", 402),
            (6, "Wren", [7, 4, 2, 0, 7, 7, 2], Content, "0.22", 64),
            (7, "Taro", [5, 7, 3, 1, 0, 0, 1], Full, "0.55", 3),
            (8, "Nim", [2, 3, 1, 5, 4, 5, 3], Asleep, "0.000", 519),
            (9, "Bump", [6, 2, 0, 4, 3, 8, 0], Ghost, "0.000", 712),
        ];
        let mut gal_json = String::from("[");
        for (i, (id, name, tr, st, bal, thoughts)) in gallery.iter().enumerate() {
            if i > 0 { gal_json.push(','); }
            let label = match st {
                Full => "full", Content => "content", Hungry => "hungry",
                Starving => "starving", Asleep => "asleep", Ghost => "ghost",
            };
            let pal = pal_of(*tr);
            // Every state's art for this exact creature, so the web app can show it
            // change as it is fed or drained — all from the real renderer.
            let mut svgs = String::from("{");
            let mut svgs_bare = String::from("{");
            for (j, (slabel, sst)) in states.iter().enumerate() {
                if j > 0 {
                    svgs.push(',');
                    svgs_bare.push(',');
                }
                svgs.push_str(&format!("\"{slabel}\":\"{}\"", svg(*tr, *sst)));
                svgs_bare.push_str(&format!("\"{slabel}\":\"{}\"", svg_bare(*tr, *sst)));
            }
            svgs.push('}');
            svgs_bare.push('}');
            gal_json.push_str(&format!(
                "{{\"id\":{id},\"name\":\"{name}\",\"state\":\"{label}\",\"balanceNear\":\"{bal}\",\"thoughts\":{thoughts},\"accent\":\"{}\",\"bg\":\"{}\",\"svgs\":{svgs},\"svgsBare\":{svgs_bare}}}",
                pal.accent, pal.bg0
            ));
        }
        gal_json.push(']');

        let json = format!(
            "{{\"hero\":{{\"name\":\"Juno\",\"accent\":\"{}\",\"bg\":\"{}\",\"states\":{hero_json},\"statesBare\":{hero_bare_json}}},\"gallery\":{gal_json}}}",
            hero_pal.accent, hero_pal.bg0
        );
        let out = std::env::var("SAMPLES_OUT").unwrap_or_else(|_| "sample-minds.json".to_string());
        std::fs::write(&out, json).expect("write samples");
        println!("samples written to {out}");
    }
}
