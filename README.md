# CityBot: A Conversational Agent for an Interactive Urban Digital Twin

**Demo paper — IEEE International Conference on Big Data (IEEE BigData 2026)**  
December 14–17, 2026 · Phoenix, AZ, USA

S. Ensiye Kiyamousavi<sup>1,2</sup>, Boris Kraychev<sup>1</sup>, Evgeny Shirinyan<sup>1</sup>, Plamena Krasteva<sup>1</sup>, Stoyan Nikolov<sup>1</sup>, Dessislava Petrova-Antonova<sup>1</sup>, Jan Bosch<sup>2</sup>, Helena Holmström Olsson<sup>3</sup>

<sup>1</sup> Big Data for Smart Society Institute (GATE), Sofia University “St. Kliment Ohridski”, Sofia, Bulgaria  
<sup>2</sup> Eindhoven University of Technology, Eindhoven, The Netherlands  
<sup>3</sup> Malmö University, Malmö, Sweden

| | |
|---|---|
| **Project website** | https://ensiyeKiya.github.io/CityBot/ |
| **Demo video** | https://drive.google.com/file/d/1pBVcRwa22TLk2tUGuEnFIg_jPMBPO1Wa/view?usp=sharing |
| **Contact** | [ensiye.kiyamousavi@gate-ai.eu](mailto:ensiye.kiyamousavi@gate-ai.eu) |

---

## Overview

Urban Digital Twins (UDT) integrate heterogeneous geospatial, environmental, and semantic data with varying spatial and temporal resolutions, but their use often remains limited to experts who operate GIS tools, domain-specific APIs, or bespoke dashboards. CityBot is a conversational user interface for exploring the UDT of **Sofia, Bulgaria**.

Building on a WoT-based architecture for integrating LLM agents with heterogeneous systems, CityBot develops an urban-specific affordance model that exposes **six resources**: a semantic 3D city model, historical air-quality data, ML-based pollution forecasts, a multi-operator environmental sensor network, Wikipedia-grounded building knowledge, and live weather and geocoding services. An LLM maps free-form requests to typed WoT actions, while a **Cesium.js** frontend renders navigation, semantic filtering, pollution replay, and forecast visualizations on an interactive 3D globe.

**Contributions**

- An LLM agent for natural-language interaction with a UDT, implemented through a WoT-based affordance model for navigation, semantic building interaction, environmental queries, historical pollution replay, and forecast visualization.
- A six-resource integration spanning a semantic 3D city model, historical air quality, pollution forecasts, a multi-operator environmental sensor network, Wikipedia-grounded building knowledge, live weather, and geocoding services.
- A bidirectionally synchronized conversational interface in which LLM-selected actions update the Cesium globe, while camera and building state context ground subsequent user requests.

---

## License

© 2026 The authors. All rights reserved.

Unpublished work provided for confidential review. No reuse, redistribution, or derivative use is permitted without the authors’ written permission.
