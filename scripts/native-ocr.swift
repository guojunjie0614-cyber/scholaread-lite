import Foundation
import Vision
import ImageIO

// Coordinates crossing the IPC boundary use the rendered image's top-left origin.
struct TextBox: Codable {
    let text: String
    let confidence: Float
    let bbox: [Double]
}

struct TextLine: Codable {
    let text: String
    let confidence: Float
    let bbox: [Double]
    let words: [TextBox]
}

struct Result: Codable {
    let engine: String
    let width: Int
    let height: Int
    let lines: [TextLine]
}

func box(_ rect: CGRect) -> [Double] {
    return [Double(rect.minX), Double(1 - rect.maxY), Double(rect.maxX), Double(1 - rect.minY)]
}

do {
    guard CommandLine.arguments.count == 2 else {
        throw NSError(domain: "ScholarLiteOCR", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Expected one PNG image path"])
    }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "ScholarLiteOCR", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Cannot decode the OCR image"])
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.minimumTextHeight = 0.003
    let languages = try request.supportedRecognitionLanguages()
    request.recognitionLanguages = ["en-US", "zh-Hans"].filter { languages.contains($0) }
    if #available(macOS 13.0, *) {
        request.automaticallyDetectsLanguage = true
    }
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    try handler.perform([request])
    let wordPattern = try NSRegularExpression(pattern: "\\S+")
    let lines: [TextLine] = try (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let text = candidate.string
        let matches = wordPattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
        let words: [TextBox] = try matches.compactMap { match in
            guard let range = Range(match.range, in: text),
                  let word = try candidate.boundingBox(for: range) else { return nil }
            return TextBox(text: String(text[range]), confidence: candidate.confidence, bbox: box(word.boundingBox))
        }
        return TextLine(text: text, confidence: candidate.confidence,
                        bbox: box(observation.boundingBox), words: words)
    }
    let result = Result(engine: "apple-vision", width: image.width, height: image.height, lines: lines)
    FileHandle.standardOutput.write(try JSONEncoder().encode(result))
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
