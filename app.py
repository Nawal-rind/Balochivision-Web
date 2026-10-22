
import streamlit as st
import torch
from PIL import Image
from transformers import AutoProcessor, AutoModelForImageTextToText
from peft import PeftModel

st.set_page_config(page_title="BalochiVision OCR", page_icon="📄")

st.title("BalochiVision")
st.subheader("Balochi Text Recognition")
st.write("Upload an image containing Balochi text to extract its text.")

MODEL_ID = "unsloth/gemma-4-E4B-it-unsloth-bnb-4bit"
ADAPTER_ID = "Nawal42/balochi-ocr-lora"

@st.cache_resource
def load_model():
    processor = AutoProcessor.from_pretrained(ADAPTER_ID)
    base_model = AutoModelForImageTextToText.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.float32,
        device_map="cpu",
        low_cpu_mem_usage=True
    )
    model = PeftModel.from_pretrained(base_model, ADAPTER_ID)
    model.eval()
    return processor, model

uploaded_file = st.file_uploader(
    "Upload a Balochi text image",
    type=["png", "jpg", "jpeg", "webp"]
)

if uploaded_file:
    image = Image.open(uploaded_file).convert("RGB")
    st.image(image, caption="Uploaded image", use_container_width=True)

    if st.button("Extract Balochi Text"):
        with st.spinner("Loading model and recognizing text..."):
            try:
                processor, model = load_model()

                messages = [{
                    "role": "user",
                    "content": [
                        {"type": "image", "image": image},
                        {"type": "text", "text": "Read and transcribe all text in this image exactly as written. Preserve the original Balochi script."}
                    ]
                }]

                prompt = processor.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True
                )

                inputs = processor(
                    text=prompt,
                    images=image,
                    return_tensors="pt"
                )

                with torch.no_grad():
                    output = model.generate(
                        **inputs,
                        max_new_tokens=512
                    )

                result = processor.decode(
                    output[0][inputs["input_ids"].shape[1]:],
                    skip_special_tokens=True
                )

                st.subheader("Recognized Text")
                st.text_area("OCR Result", result, height=200)
                st.download_button(
                    "Download Text",
                    data=result,
                    file_name="balochi_ocr.txt",
                    mime="text/plain"
                )

            except Exception as e:
                st.error(f"Error: {e}")
