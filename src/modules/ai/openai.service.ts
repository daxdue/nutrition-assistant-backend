import OpenAI from "openai";

const model = "gpt-4.1-mini";
const openai = new OpenAI();

export const processImage = async (imageBuffer: Buffer, prompt: string) => {
    const base64 = imageBuffer.toString("base64");
    const response = await openai.responses.create({
        model: model,
        input: [
            {
                role: 'user',
                content: [
                    {
                        type: "input_text", text: prompt
                    },
                    {
                        type: "input_image",
                        image_url: `data:image/jpeg;base64,${base64}`,
                        detail: 'auto'
                    },
                ],
            },
        ],
    });

    const text = response.output_text;

    console.log("Response from OpenAI", text);

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        console.error("Failed to parse OpenAI JSON:", e, text);
        throw e;
    }

    return parsed;
};