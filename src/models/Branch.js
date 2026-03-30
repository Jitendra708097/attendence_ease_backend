module.exports = (sequelize, DataTypes) => {
  const Branch = sequelize.define(
    'Branch',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      address: DataTypes.TEXT,
      geo_fence_polygons: DataTypes.JSONB,
      is_remote: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      wifi_verification_enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      allowed_bssids: {
        type: DataTypes.JSONB,
        defaultValue: [],
      },
    },
    {
      tableName: 'branches',
      paranoid: true,
      underscored: true,
    }
  );

  Branch.associate = (models) => {
    Branch.belongsTo(models.Organisation, {
      foreignKey: 'org_id',
      as: 'organisation',
    });
    Branch.hasMany(models.Employee, {
      foreignKey: 'branch_id',
      as: 'employees',
    });
  };

  return Branch;
};
