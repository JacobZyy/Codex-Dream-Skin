import Foundation
import XCTest
@testable import DreamSkinCore

final class ChatBubbleConfigurationTests: XCTestCase {
  private let savedStyle = ##"{"foreground":"#C6D0F5","background":"#414559","transparency":25,"blur":24}"##

  func testFollowingThemeDoesNotDisplayRetainedIndependentSnapshot() throws {
    let data = Data("""
    {"preferences":{"schemaVersion":1,"mode":"theme","presetId":"frappe","style":\(savedStyle)},
     "presets":[],"effectiveStyle":null,"themeStyle":null,"warnings":[]}
    """.utf8)
    let configuration = try ChatBubbleConfiguration.decode(data)
    XCTAssertEqual(configuration.preferences.mode, .theme)
    XCTAssertNotNil(configuration.preferences.style)
    XCTAssertNil(configuration.effectiveStyle)
    XCTAssertNil(configuration.themeStyle)
  }

  func testPresetConfigurationAndLocalizedCatalogDecode() throws {
    let data = Data("""
    {"preferences":{"schemaVersion":1,"mode":"preset","presetId":"frappe","style":\(savedStyle)},
     "presets":[{"id":"frappe","name":"芙拉佩","nameEn":"Catppuccin Frappé","style":\(savedStyle)}],
     "effectiveStyle":\(savedStyle),"themeStyle":null,"warnings":["Theme style unavailable"]}
    """.utf8)
    let configuration = try ChatBubbleConfiguration.decode(data)
    XCTAssertEqual(configuration.preferences.mode, .preset)
    XCTAssertEqual(configuration.effectiveStyle, configuration.preferences.style)
    XCTAssertEqual(configuration.presets.first?.nameEn, "Catppuccin Frappé")
    XCTAssertEqual(configuration.warnings, ["Theme style unavailable"])
  }

  func testCustomValuesAreStrictAndProduceSeparateCLIArguments() throws {
    let style = try ChatBubbleStyle(foreground: "#c6d0f5", background: "#414559", transparency: 25.5, blur: 24)
    XCTAssertEqual(style.customCommand, ["custom", "--foreground", "#c6d0f5", "--background", "#414559", "--transparency", "25.5", "--blur", "24.0"])
    for color in ["#fff", "#12345678", "red", "#12 456", "#123456; echo invalid"] {
      XCTAssertThrowsError(try ChatBubbleStyle(foreground: color, background: "#414559", transparency: 25, blur: 24))
    }
    for value in [-1.0, 100.1, .infinity, .nan] {
      XCTAssertThrowsError(try ChatBubbleStyle(foreground: "#C6D0F5", background: "#414559", transparency: value, blur: 24))
    }
    for value in [-1.0, 64.1, .infinity, .nan] {
      XCTAssertThrowsError(try ChatBubbleStyle(foreground: "#C6D0F5", background: "#414559", transparency: 25, blur: value))
    }
    XCTAssertNoThrow(try ChatBubbleStyle(foreground: "#000000", background: "#FFFFFF", transparency: 0, blur: 0))
    XCTAssertNoThrow(try ChatBubbleStyle(foreground: "#000000", background: "#FFFFFF", transparency: 100, blur: 64))
  }

  func testRejectsUnsupportedPreferencesAndInvalidSnapshot() {
    for preferences in [
      #"{"schemaVersion":2,"mode":"theme"}"#,
      #"{"schemaVersion":1,"mode":"other"}"#,
      #"{"schemaVersion":1,"mode":"preset"}"#,
      ##"{"schemaVersion":1,"mode":"preset","style":{"foreground":"#fff","background":"#414559","transparency":25,"blur":24}}"##,
    ] {
      let data = Data("""
      {"preferences":\(preferences),"presets":[],"effectiveStyle":null,"themeStyle":null,"warnings":[]}
      """.utf8)
      XCTAssertThrowsError(try ChatBubbleConfiguration.decode(data))
    }
    XCTAssertThrowsError(try ChatBubbleConfiguration.decode(Data(repeating: 32, count: 262_145)))
  }
}
