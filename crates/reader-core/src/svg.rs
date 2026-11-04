/// Serve SVG only when it does not carry active content.
/// Unsafe files are replaced with a static placeholder so the original
/// payload never reaches the WebView. Raster images are checked separately
/// by magic bytes.
pub fn sanitize_svg(input: &str) -> String {
    if svg_is_unsafe(input) {
        PLACEHOLDER.to_string()
    } else {
        input.to_string()
    }
}

const PLACEHOLDER: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"48\" role=\"img\" aria-label=\"Blocked image\"><rect width=\"100%\" height=\"100%\" fill=\"#f4efe6\"/><text x=\"12\" y=\"30\" font-size=\"14\" fill=\"#1c1915\">Image blocked</text></svg>";

fn svg_is_unsafe(input: &str) -> bool {
    let folded = input.to_ascii_lowercase();
    if folded.contains("<!entity") || folded.contains("<!doctype") {
        return true;
    }
    const NEEDLES: &[&str] = &[
        "<script",
        "</script",
        "<foreignobject",
        "<iframe",
        "<embed",
        "<object",
        "<audio",
        "<video",
        "<link",
        "<meta",
        "<handler",
        "javascript:",
        "vbscript:",
        "data:text/html",
        "onload",
        "onerror",
        "onclick",
        "onmouseover",
        "onfocus",
        "onbegin",
        "onend",
        "href=\"http",
        "href='http",
        "xlink:href=\"http",
        "xlink:href='http",
    ];
    NEEDLES.iter().any(|n| folded.contains(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_plain_svg() {
        let src = r#"<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>"#;
        assert_eq!(sanitize_svg(src), src);
    }

    #[test]
    fn blocks_script_handlers_and_entities() {
        let samples = [
            r#"<svg><script>alert(1)</script></svg>"#,
            r#"<svg onload="alert(1)"></svg>"#,
            r#"<svg><a href="javascript:alert(1)">x</a></svg>"#,
            r#"<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg>&xxe;</svg>"#,
            r#"<svg><foreignObject><iframe src="javascript:alert(1)"/></foreignObject></svg>"#,
        ];
        for sample in samples {
            let out = sanitize_svg(sample);
            assert!(!out.to_ascii_lowercase().contains("alert"), "{sample}");
            assert!(!out.contains("passwd"), "{sample}");
            assert!(out.contains("Image blocked"));
        }
    }
}
