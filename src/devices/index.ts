/**
 * Device profiles (design §3, §6, §6.4): the profile format, the built-in
 * profiles and auto-detection. Profiles sit beside the layer stack; NetconfClient passes
 * each part of a profile to the layer it belongs to.
 */

export {
  defineDeviceProfile,
  autoDetect,
  pickProfile,
  matcher,
  bindDevice,
  QUIRK_NAMES,
  type AutoDetect,
  type ConnectionDefaults,
  type DeviceContext,
  type DeviceHandle,
  type DeviceMatch,
  type ProfileSource,
  type DeviceOperation,
  type DeviceProfile,
  type Quirks,
  type YangSettings,
} from './device.js';
export { compileProfile, ProfileError, type DeviceProfileSpec, type OperationSpec, type ProfileParamType } from './profile-spec.js';
export { builtinDeviceProfiles } from './profile-builtin.js';
// Loading profiles from files (loadDeviceProfile, loadDeviceProfiles) is Node-only:
// the Node entry imports ./profile-loader.ts itself, so this barrel stays portable.
