#!/usr/bin/env python3
import sys
import json
import whisper_timestamped as whisper

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No audio file path provided"}))
        return

    audio_path = sys.argv[1]
    try:
        # Загружаем модель (можно 'tiny', 'base', 'small', 'medium', 'large')
        model = whisper.load_model("base", device="cpu")
        # Распознаём с таймкодами
        result = whisper.transcribe(model, audio_path, language="ru")
        
        segments = result['segments']
        output = []
        for seg in segments:
            output.append({
                "text": seg['text'].strip(),
                "start": seg['start'],
                "end": seg['end']
            })
        print(json.dumps(output))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()