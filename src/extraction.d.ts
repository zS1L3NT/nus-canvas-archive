declare module "@tesseract.js-data/eng" {
  const english: { langPath: string };
  export default english;
}

declare module "word-extractor" {
  export default class WordExtractor {
    extract(data: Buffer): Promise<{
      getBody(options: { filterUnicode: boolean }): string;
      getHeaders(options: { filterUnicode: boolean }): string;
      getFootnotes(options: { filterUnicode: boolean }): string;
      getEndnotes(options: { filterUnicode: boolean }): string;
      getTextboxes(options: { filterUnicode: boolean }): string;
    }>;
  }
}

declare module "rtf-parser" {
  export interface RtfNode {
    value?: string;
    content?: RtfNode[];
  }
  const parseRtf: {
    string(text: string, callback: (error: Error | null, document: RtfNode) => void): void;
  };
  export default parseRtf;
}
