# CityBot: Talking to and Steering an Urban Digital Twin

**Demo paper — IEEE International Conference on Big Data (IEEE BigData 2026)**  
December 14–17, 2026 · Phoenix, AZ, USA

CityBot is a conversational interface for exploring **Sofia, Bulgaria**’s urban digital twin. Built on the [W3C Web of Things (WoT)](https://www.w3.org/TR/wot-thing-description/), it exposes heterogeneous city data as typed WoT actions. A large language model maps free-form requests to those actions; a **Cesium.js** frontend renders navigation, semantic building filters, pollution replay, and forecast visualizations on an interactive 3D globe.

| | |
|---|---|
| **Project website** | https://ensiyeKiya.github.io/CityBot/ |
| **Demo video** | https://drive.google.com/file/d/1MRbgV6DzjyMyLMXZdkv8f5_yNHTpm7a8/view |
| **Source code** | https://github.com/ensiyeKiya/CityBot |

---

## Overview

Urban digital twins integrate geospatial, environmental, and semantic data, but their use often remains limited to experts operating GIS tools, domain-specific APIs, or bespoke dashboards. CityBot lowers this barrier with a **WoT-grounded conversational interface** that exposes Sofia’s digital twin as a machine-readable affordance catalog over HTTP and MQTT.

Building on a WoT-based architecture for integrating LLM agents with heterogeneous systems ([Kiyamousavi et al., 2025](https://github.com/ensiyeKiya/CityBot)), CityBot maintains **bidirectional synchronization** between dialogue and the live 3D environment: LLM-selected actions update the Cesium.js globe, while camera and building selection state ground subsequent user requests.

---

## License

All rights reserved to the authors.
