/** Procedural humanoid and prop renderers (design §12.1-12.2). */
export {
  BODY,
  FIGURE_FLAG,
  HELD,
  POSE,
  PROP,
  PROP_BY_NAME,
  createHumanoidSource,
  createLimbPose,
  createPropSource,
  limbPose,
  limbPoseAt,
  type HumanoidSource,
  type LimbPose,
  type PropSource,
} from './pose';
export { PeopleRenderer, type PeopleRendererOptions } from './peopleRenderer';
export { PropRenderer } from './propRenderer';
