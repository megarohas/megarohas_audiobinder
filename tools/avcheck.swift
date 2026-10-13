// Prints what Apple's AVFoundation (the engine behind Books/Music) sees in a file:
// duration, iTunes tags, chapters and chapter artwork.
//   swiftc -O tools/avcheck.swift -o build/avcheck && build/avcheck book.m4b

import AVFoundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
let sema = DispatchSemaphore(value: 0)
Task {
  do {
    let dur = try await asset.load(.duration)
    print("duration:", dur.seconds)
    let meta = try await asset.load(.metadata)
    for item in meta {
      let key = item.identifier?.rawValue ?? "?"
      var v = ""
      if let s = try? await item.load(.stringValue) { v = s } else if let d = try? await item.load(.dataValue) { v = "<\(d.count) bytes>" } else if let n = try? await item.load(.numberValue) { v = "\(n)" }
      print("meta", key, "=", v.prefix(60))
    }
    let langs = try await asset.load(.availableChapterLocales)
    let groups = try await asset.loadChapterMetadataGroups(bestMatchingPreferredLanguages: langs.map { $0.identifier } + ["und"])
    print("chapters:", groups.count)
    for g in groups {
      var title = "", art = ""
      for it in g.items {
        if it.commonKey == .commonKeyTitle { title = (try? await it.load(.stringValue)) ?? "" }
        if it.commonKey == .commonKeyArtwork { let d = try? await it.load(.dataValue); art = " art=\(d?.count ?? 0)B" }
      }
      print(String(format: "  %.3f +%.3f ", g.timeRange.start.seconds, g.timeRange.duration.seconds), title, art)
    }
  } catch { print("ERROR", error) }
  sema.signal()
}
sema.wait()
