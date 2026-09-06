import type { AllowDenyRequirement } from "./AllowDenyRequirement";
import type { ComputerUseWindowsExeRequirement } from "./ComputerUseWindowsExeRequirement";
export type ComputerUseWindowsRequirements = {
    aumids: {
        [key in string]?: AllowDenyRequirement;
    } | null;
    exes: Array<ComputerUseWindowsExeRequirement> | null;
};
//# sourceMappingURL=ComputerUseWindowsRequirements.d.ts.map