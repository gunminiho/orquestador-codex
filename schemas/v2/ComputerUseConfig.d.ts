import type { AllowDenyRequirement } from "./AllowDenyRequirement";
import type { ComputerUseMacosConfig } from "./ComputerUseMacosConfig";
import type { ComputerUseWindowsConfig } from "./ComputerUseWindowsConfig";
export type ComputerUseConfig = {
    default_app_access: AllowDenyRequirement | null;
    macos: ComputerUseMacosConfig | null;
    windows: ComputerUseWindowsConfig | null;
};
//# sourceMappingURL=ComputerUseConfig.d.ts.map