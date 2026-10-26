import Foundation
import DreamSkinCore

struct ScriptResult {
  let exitCode: Int32
  let output: String

  var succeeded: Bool { exitCode == 0 }
}

enum ScriptRunner {
  static func run(
    script: URL,
    arguments: [String] = [],
    completion: @escaping (ScriptResult) -> Void
  ) {
    run(
      executable: URL(fileURLWithPath: "/bin/bash"),
      arguments: [script.path] + arguments,
      directory: script.deletingLastPathComponent(),
      completion: completion
    )
  }

  static func runChatBubbles(
    engine: URL,
    preferences: URL,
    theme: URL? = nil,
    command: [String],
    completion: @escaping (ScriptResult) -> Void
  ) {
    // Paths and user values remain positional arguments, never shell source.
    let bridge = #"set -euo pipefail; source "$1"; shift; ensure_node_runtime; exec "$NODE" "$@""#
    let arguments = ["-c", bridge, "dreamskin-chat-bubbles",
                     engine.appendingPathComponent("scripts/common-macos.sh").path,
                     engine.appendingPathComponent("assets/chat-bubbles.mjs").path]
      + command + ["--preferences", preferences.path]
      + (theme.map { ["--theme", $0.path] } ?? [])
    run(
      executable: URL(fileURLWithPath: "/bin/bash"),
      arguments: arguments,
      directory: engine,
      completion: completion
    )
  }

  private static func run(
    executable: URL,
    arguments: [String],
    directory: URL,
    completion: @escaping (ScriptResult) -> Void
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      let process = Process()
      let pipe = Pipe()
      process.executableURL = executable
      process.arguments = arguments
      process.currentDirectoryURL = directory
      var environment = ProcessInfo.processInfo.environment
      environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"
      environment["LC_ALL"] = "en_US.UTF-8"
      environment["DREAMSKIN_LANG"] = DreamSkinLanguage.stored().environmentValue
      process.environment = environment
      process.standardOutput = pipe
      process.standardError = pipe

      let result: ScriptResult
      do {
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        result = ScriptResult(
          exitCode: process.terminationStatus,
          output: String(decoding: data, as: UTF8.self)
        )
      } catch {
        result = ScriptResult(exitCode: 127, output: error.localizedDescription)
      }
      DispatchQueue.main.async {
        completion(result)
      }
    }
  }
}
