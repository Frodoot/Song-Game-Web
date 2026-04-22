export type ITranscriptLine = {
    start: string;
    end: string;
    speech: string;
};
export default function parseTranscript(vtt: string): ITranscriptLine[];
