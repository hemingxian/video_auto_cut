import { Composition } from 'remotion';
import activePlan from './active-plan.json';
import { AiGeneratedMaterialVideo } from './AiGeneratedMaterialVideo.jsx';

const FPS = 30;
const duration = Math.min(180, Math.max(1, Number(activePlan.duration || 6)));

export const Root = () => {
  return (
    <Composition
      id="GeneratedMaterial"
      component={AiGeneratedMaterialVideo}
      durationInFrames={Math.round(duration * FPS)}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ plan: activePlan }}
    />
  );
};
