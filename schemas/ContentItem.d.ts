import type { ImageDetail } from "./ImageDetail";
export type ContentItem = {
    "type": "input_text";
    text: string;
} | {
    "type": "input_image";
    image_url: string;
    detail?: ImageDetail;
} | {
    "type": "input_audio";
    audio_url: string;
} | {
    "type": "output_text";
    text: string;
};
//# sourceMappingURL=ContentItem.d.ts.map