import { memo, useRef, useState } from "react";
import { MIC_RECORDING_FILENAME } from "./VoiceRecorder";

const TrimmedAudioPreviewUnmemoized = ({ file }: { file: File }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const maxDurationSec = 10;

  const handleTimeUpdate = () => {
    if (audioRef.current && audioRef.current.currentTime >= maxDurationSec) {
      // If playing, restart the playhead to 0 so that you can just press the play
      // button to play again. If paused, max duration to indicate trimming
      audioRef.current.currentTime = audioRef.current.paused
        ? maxDurationSec
        : 0;

      audioRef.current.pause();
    }
  };

  const handleDurationChange = () => {
    setDuration(audioRef.current?.duration || null);
  };

  return (
    <div>
      {file.name !== MIC_RECORDING_FILENAME && (
        <div className="text-sm text-lightgray">
          Selected file: <strong>{file.name}</strong>
        </div>
      )}
      {duration && duration > maxDurationSec + 1 && (
        <div className="text-sm text-white">
          Note that <strong>only the first {maxDurationSec} seconds</strong>{" "}
          will be used.
        </div>
      )}
      <audio
        ref={audioRef}
        controls
        src={URL.createObjectURL(file)}
        className="w-full mt-2"
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={handleDurationChange}
      />
    </div>
  );
};

// We memoize because otherwise the <audio /> element resets playback
// when we re-render
const TrimmedAudioPreview = memo(TrimmedAudioPreviewUnmemoized);

export default TrimmedAudioPreview;
