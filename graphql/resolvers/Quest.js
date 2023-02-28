const { Service: _QuestService } = require("../../services/QuestService");

const resolvers = {
  QuestRewardItem: {
    __resolveType(parent) {
      switch (parent.type) {
        case "ASSET_3D":
          return "Asset3DUnion";
        default:
          return "Asset3DUnion";
      }
    },
  },
  QuestReward: {
    reward: async (parent) => {
      const QuestService = new _QuestService();
      const reward = await QuestService.getQuestReward(parent);
      if (parent.type === "ASSET_3D") {
        return {
          _id: parent.rewardId,
          type: parent.type,
          asset3D: reward,
        };
      } else {
        return null;
      }
    },
  },
};

module.exports = { resolvers };
