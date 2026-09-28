import { createRoute } from '@tanstack/react-router';
import { FramesGallery } from '../dev/FramesGallery';
import { rootRoute } from './root';

// Dev-only: a sibling of the authed layout, not a child, so it never runs the
// session gate and never calls the API (router.tsx only registers this in dev).
export const framesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/_frames',
  component: FramesGallery,
});
