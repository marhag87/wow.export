{
  "targets": [
    {
      "target_name": "screencap",
      "sources": [
        "src/screencap.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        ["OS=='win'", {
          "defines": [
            "_WIN32_WINNT=0x0600"
          ],
          "libraries": [
            "-lgdi32",
            "-luser32"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }],
        ["OS=='mac'", {
          "cflags_cc": ["-std=c++17"]
        }],
        ["OS=='linux'", {
          "cflags_cc": ["-std=c++17"]
        }]
      ]
    }
  ]
}
