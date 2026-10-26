import Foundation

public struct ChatBubbleStyle: Decodable, Equatable {
  public let foreground: String
  public let background: String
  public let transparency: Double
  public let blur: Double

  public init(foreground: String, background: String, transparency: Double, blur: Double) throws {
    guard [foreground, background].allSatisfy({ $0.range(of: #"^#[0-9A-Fa-f]{6}$"#, options: .regularExpression) != nil }),
          transparency.isFinite, (0...100).contains(transparency),
          blur.isFinite, (0...64).contains(blur) else {
      throw CocoaError(.fileReadCorruptFile)
    }
    self.foreground = foreground
    self.background = background
    self.transparency = transparency
    self.blur = blur
  }

  private enum CodingKeys: String, CodingKey {
    case foreground, background, transparency, blur
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      foreground: values.decode(String.self, forKey: .foreground),
      background: values.decode(String.self, forKey: .background),
      transparency: values.decode(Double.self, forKey: .transparency),
      blur: values.decode(Double.self, forKey: .blur)
    )
  }

  public var customCommand: [String] {
    ["custom", "--foreground", foreground, "--background", background,
     "--transparency", String(transparency), "--blur", String(blur)]
  }
}

public struct ChatBubbleConfiguration: Decodable, Equatable {
  public struct Preferences: Decodable, Equatable {
    public enum Mode: String, Decodable { case theme, preset }
    public let schemaVersion: Int
    public let mode: Mode
    public let presetId: String?
    public let style: ChatBubbleStyle?
  }

  public struct Preset: Decodable, Equatable {
    public let id: String
    public let name: String
    public let nameEn: String?
    public let style: ChatBubbleStyle
  }

  public let preferences: Preferences
  public let presets: [Preset]
  public let effectiveStyle: ChatBubbleStyle?
  public let themeStyle: ChatBubbleStyle?
  public let warnings: [String]

  public static func decode(_ data: Data) throws -> Self {
    guard data.count <= 262_144 else { throw CocoaError(.fileReadTooLarge) }
    let configuration = try JSONDecoder().decode(Self.self, from: data)
    guard configuration.preferences.schemaVersion == 1,
          configuration.preferences.mode != .preset || configuration.preferences.style != nil else {
      throw CocoaError(.fileReadCorruptFile)
    }
    return configuration
  }
}
