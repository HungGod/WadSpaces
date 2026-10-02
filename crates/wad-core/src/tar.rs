//! A ustar archive of the build folder: what wadd builds from (src/core/tar.ts).
//! Entries go in UTF-8 byte order with their parent directories, mtime 0, so
//! the same folder always gives the same bytes (and build cache hits).

/// One file of the folder, by its path relative to the folder.
pub struct Entry<'a> {
    pub path: &'a str,
    pub content: &'a [u8],
}

fn header(name: &str, size: usize, kind: u8) -> Result<[u8; 512], String> {
    let mut h = [0u8; 512];
    let (mut prefix, mut base) = (String::new(), name.to_string());
    if name.len() > 100 {
        // `name.lastIndexOf("/", 155)`: in UTF-16 units, as JS counts.
        let units: Vec<u16> = name.encode_utf16().collect();
        let cut = units.iter().take(156).rposition(|&u| u == b'/' as u16);
        let ok = cut.map(|c| {
            prefix = String::from_utf16_lossy(&units[..c]);
            base = String::from_utf16_lossy(&units[c + 1..]);
            base.len() <= 100 && prefix.len() <= 155
        });
        if ok != Some(true) {
            return Err(format!("path too long for a build folder: {name}"));
        }
    }
    let put = |h: &mut [u8; 512], s: &[u8], at: usize| {
        let end = (at + s.len()).min(512);
        h[at..end].copy_from_slice(&s[..end - at]);
    };
    let oct = |n: usize, len: usize| format!("{n:0>w$o}\0", w = len - 1);
    put(&mut h, base.as_bytes(), 0);
    put(&mut h, if kind == b'5' { b"0000755\0" } else { b"0000644\0" }, 100);
    put(&mut h, b"0000000\0", 108);
    put(&mut h, b"0000000\0", 116);
    put(&mut h, oct(size, 12).as_bytes(), 124);
    put(&mut h, oct(0, 12).as_bytes(), 136);
    put(&mut h, b"        ", 148);
    h[156] = kind;
    put(&mut h, b"ustar\0", 257);
    put(&mut h, b"00", 263);
    put(&mut h, prefix.as_bytes(), 345);
    let sum: u32 = h.iter().map(|&b| b as u32).sum();
    put(&mut h, format!("{sum:06o}\0 ").as_bytes(), 148);
    Ok(h)
}

/// The files as a tar, with their parent directories.
pub fn tar(entries: &[Entry]) -> Result<Vec<u8>, String> {
    let mut sorted: Vec<&Entry> = entries.iter().collect();
    sorted.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    let mut out = Vec::new();
    let mut dirs: Vec<String> = Vec::new();
    for e in sorted {
        if e.path.starts_with('/') || e.path.split('/').any(|s| s == "..") {
            return Err(format!("bad path in build folder: {}", e.path));
        }
        let segs: Vec<&str> = e.path.split('/').collect();
        for i in 1..segs.len() {
            let d = format!("{}/", segs[..i].join("/"));
            if !dirs.contains(&d) {
                out.extend_from_slice(&header(&d, 0, b'5')?);
                dirs.push(d);
            }
        }
        out.extend_from_slice(&header(e.path, e.content.len(), b'0')?);
        out.extend_from_slice(e.content);
        let pad = (512 - e.content.len() % 512) % 512;
        out.resize(out.len() + pad, 0);
    }
    out.resize(out.len() + 1024, 0);
    Ok(out)
}
