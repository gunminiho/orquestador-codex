import type { AllowDenyRequirement } from "./AllowDenyRequirement";
import type { ComputerUseWindowsExeConfig } from "./ComputerUseWindowsExeConfig";
export type ComputerUseWindowsConfig = {
    aumids: {
        [key in string]?: AllowDenyRequirement;
    } | null;
    exes: Array<ComputerUseWindowsExeConfig> | null;
};
//# sourceMappingURL=ComputerUseWindowsConfig.d.ts.map