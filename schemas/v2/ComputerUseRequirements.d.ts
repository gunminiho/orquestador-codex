import type { AllowDenyRequirement } from "./AllowDenyRequirement";
import type { ComputerUseMacosRequirements } from "./ComputerUseMacosRequirements";
import type { ComputerUseWindowsRequirements } from "./ComputerUseWindowsRequirements";
export type ComputerUseRequirements = {
    allowLockedComputerUse: boolean | null;
    allowPersistentApproval: boolean | null;
    defaultAppAccess: AllowDenyRequirement | null;
    macos: ComputerUseMacosRequirements | null;
    windows: ComputerUseWindowsRequirements | null;
};
//# sourceMappingURL=ComputerUseRequirements.d.ts.map